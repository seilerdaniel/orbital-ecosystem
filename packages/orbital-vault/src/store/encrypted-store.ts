/**
 * Encrypted secret store backed by SQLite (`node:sqlite`) and AES-256-GCM
 * (`node:crypto`). Zero native dependencies.
 *
 * Layout of `<dbPath>` (default ~/.config/orbital/vault.db):
 * - meta(key TEXT PRIMARY KEY, value TEXT)      kdf parameters
 * - secrets(name TEXT PRIMARY KEY, ...)          encrypted payloads
 *
 * Payload format: [12B iv][16B GCM tag][ciphertext]. The entry name is
 * bound as GCM additional authenticated data, so a payload cannot be
 * transplanted under another key name. The master key never touches disk:
 * it is derived per-unlock from the passphrase via scrypt using a random
 * salt persisted in `meta`; correctness of the passphrase is proven by
 * decrypting an internal verifier record.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_VAULT_PATH = join(homedir(), ".config", "orbital", "vault.db");

const KDF_SALT_META = "kdf_salt_hex";
const KDF_PARAMS_META = "kdf_params_json";
const INIT_FLAG_META = "initialized";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
/** Reserved internal entry proving the passphrase during unlock. */
const CHECK_NAME = "\u0000orbital-vault-check";
const CHECK_PLAINTEXT = "orbital-vault-v1";

export class VaultLockedError extends Error {
  constructor() {
    super("Vault is locked: unlock it before accessing secrets");
    this.name = "VaultLockedError";
  }
}

/** Wrong passphrase or tampered/corrupted ciphertext (GCM auth failure). */
export class VaultAuthError extends Error {
  constructor(message = "Vault authentication failed: wrong passphrase or corrupted data") {
    super(message);
    this.name = "VaultAuthError";
  }
}

interface MetaRow {
  value: string;
}

interface SecretRow {
  payload: Uint8Array;
  created_at: string;
  updated_at: string;
}

function zeroFill(buffer: Buffer | undefined): void {
  buffer?.fill(0);
}

export class EncryptedStore {
  private readonly db: DatabaseSync;
  private readonly salt: Buffer;
  private readonly scryptParams: { N: number; r: number; p: number };
  private key: Buffer | undefined;

  constructor(options: { path?: string } = {}) {
    const filePath = options.path ?? process.env.ORBITAL_VAULT_DB ?? DEFAULT_VAULT_PATH;

    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS secrets (
        name TEXT PRIMARY KEY,
        payload BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.salt = this.loadOrCreateSalt();
    this.scryptParams = this.loadOrCreateParams();
  }

  /**
   * True only after {@link initializeWith} ran for this file. Salt rows are
   * created eagerly by the constructor, so they cannot signal freshness.
   */
  isInitialized(): boolean {
    return this.readMeta(INIT_FLAG_META) === "1";
  }

  isUnlocked(): boolean {
    return this.key !== undefined;
  }

  /** Derives the master key and proves it against the internal verifier. */
  unlock(passphrase: string): void {
    const key = scryptSync(passphrase, this.salt, KEY_BYTES, this.scryptParams);

    try {
      const plaintext = this.decrypt(CHECK_NAME, this.readSecretRow(CHECK_NAME)?.payload, key);

      if (plaintext !== CHECK_PLAINTEXT) {
        throw new VaultAuthError();
      }
    } catch (error) {
      zeroFill(key);

      if (error instanceof VaultAuthError) {
        throw error;
      }

      throw new VaultAuthError();
    }

    zeroFill(this.key);
    this.key = key;
  }

  /** First-time setup: creates the verifier so later unlocks can be proven. */
  initializeWith(passphrase: string): void {
    const key = scryptSync(passphrase, this.salt, KEY_BYTES, this.scryptParams);

    try {
      this.writeRaw(CHECK_NAME, this.encrypt(CHECK_NAME, CHECK_PLAINTEXT, key));
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(INIT_FLAG_META, "1");
    } finally {
      zeroFill(key);
    }
  }

  lock(): void {
    zeroFill(this.key);
    this.key = undefined;
  }

  setSecret(name: string, value: string): void {
    this.assertUnlocked();
    this.writeRaw(name, this.encrypt(name, value, this.key as Buffer));
  }

  getSecret(name: string): string | undefined {
    this.assertUnlocked();

    const row = this.readSecretRow(name);

    if (row === undefined) {
      return undefined;
    }

    return this.decrypt(name, row.payload, this.key as Buffer);
  }

  deleteSecret(name: string): boolean {
    this.assertUnlocked();

    return Number(
      this.db.prepare("DELETE FROM secrets WHERE name = ?").run(name).changes
    ) > 0;
  }

  /** All stored entry names, excluding the internal verifier. */
  listSecrets(): string[] {
    this.assertUnlocked();

    const rows = this.db.prepare("SELECT name FROM secrets ORDER BY name").all() as unknown as {
      name: string;
    }[];

    return rows.map((row) => row.name).filter((name) => name !== CHECK_NAME);
  }

  close(): void {
    this.lock();
    this.db.close();
  }

  // --- internals ------------------------------------------------------------

  private assertUnlocked(): void {
    if (!this.isUnlocked()) {
      throw new VaultLockedError();
    }
  }

  private readMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | MetaRow
      | undefined;

    return row?.value;
  }

  private loadOrCreateSalt(): Buffer {
    const existing = this.readMeta(KDF_SALT_META);

    if (existing !== undefined) {
      return Buffer.from(existing, "hex");
    }

    const salt = randomBytes(16);

    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
      .run(KDF_SALT_META, salt.toString("hex"));

    return salt;
  }

  private loadOrCreateParams(): { N: number; r: number; p: number } {
    const raw = this.readMeta(KDF_PARAMS_META);

    if (raw !== undefined) {
      return JSON.parse(raw) as { N: number; r: number; p: number };
    }

    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
      .run(KDF_PARAMS_META, JSON.stringify(SCRYPT_PARAMS));

    return { ...SCRYPT_PARAMS };
  }

  private readSecretRow(name: string): SecretRow | undefined {
    return this.db.prepare("SELECT payload, created_at, updated_at FROM secrets WHERE name = ?").get(name) as
      | SecretRow
      | undefined;
  }

  private writeRaw(name: string, payload: Buffer): void {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO secrets (name, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      )
      .run(name, payload, now, now);
  }

  private encrypt(name: string, plaintext: string, key: Buffer): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);

    cipher.setAAD(Buffer.from(name, "utf8"));

    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return Buffer.concat([iv, tag, ciphertext]);
  }

  private decrypt(name: string, payload: Uint8Array | undefined, key: Buffer): string {
    if (payload === undefined || payload.length < IV_BYTES + 16) {
      throw new VaultAuthError(`Vault entry "${name}" is missing or truncated`);
    }

    const buffer = Buffer.from(payload);
    const iv = buffer.subarray(0, IV_BYTES);
    const tag = buffer.subarray(IV_BYTES, IV_BYTES + 16);
    const ciphertext = buffer.subarray(IV_BYTES + 16);

    const decipher = createDecipheriv("aes-256-gcm", key, iv);

    decipher.setAAD(Buffer.from(name, "utf8"));
    decipher.setAuthTag(tag);

    try {
      return `${decipher.update(ciphertext)}${decipher.final("utf8")}`;
    } catch {
      throw new VaultAuthError();
    }
  }
}
