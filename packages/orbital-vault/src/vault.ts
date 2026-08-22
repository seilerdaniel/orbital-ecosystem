/**
 * Persistent implementation of the {@link Vault} contract backed by the
 * AES-256-GCM SQLite store. Adds credential-injection helpers so subagent
 * sessions can receive secrets as environment variables without secrets
 * ever appearing in source code, CLI arguments, or logs.
 */

import { EncryptedStore } from "./store/encrypted-store.js";

export interface SqliteVaultOptions {
  /** DB file; defaults to ORBITAL_VAULT_DB or ~/.config/orbital/vault.db */
  readonly path?: string;
}

export class SqliteVault {
  private readonly store: EncryptedStore;

  constructor(options: SqliteVaultOptions = {}) {
    this.store = new EncryptedStore(
      options.path === undefined ? {} : { path: options.path }
    );
  }

  isUnlocked(): boolean {
    return this.store.isUnlocked();
  }

  /**
   * Idempotent unlock. On a fresh file the passphrase initializes the
   * verifier; afterwards every unlock must prove itself against it.
   */
  unlock(passphrase: string): void {
    if (!this.store.isInitialized()) {
      this.store.initializeWith(passphrase);
    }

    this.store.unlock(passphrase);
  }

  lock(): void {
    this.store.lock();
  }

  getSecret(key: string): string | undefined {
    return this.store.getSecret(key);
  }

  setSecret(key: string, value: string): void {
    this.store.setSecret(key, value);
  }

  deleteSecret(key: string): boolean {
    return this.store.deleteSecret(key);
  }

  listSecrets(): string[] {
    return this.store.listSecrets();
  }

  close(): void {
    this.store.close();
  }

  /**
   * Resolves `{ ENV_NAME: "vault/key" }` into concrete environment values.
   * The mapping (safe to commit) references logical vault keys only;
   * values stay inside the encrypted store until this call.
   */
  resolveEnv(mapping: Readonly<Record<string, string>>): Record<string, string> {
    const resolved: Record<string, string> = {};

    for (const [envName, secretKey] of Object.entries(mapping)) {
      const value = this.store.getSecret(secretKey);

      if (value !== undefined) {
        resolved[envName] = value;
      }
    }

    return resolved;
  }

  /**
   * Builds a child-process env: current process.env plus resolved secrets.
   * Pass the result straight to spawn/fork — do not assign it back into a
   * long-lived process.env unless strictly necessary.
   */
  buildChildEnv(mapping: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
    return { ...process.env, ...this.resolveEnv(mapping) };
  }
}
