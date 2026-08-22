/**
 * The platform-agnostic Vault contract plus an in-memory reference
 * implementation used by tests and examples. Production code should prefer
 * {@link ../vault.ts | SqliteVault}, which satisfies the same contract
 * structurally while persisting AES-256-GCM encrypted entries.
 */

import { VaultLockedError } from "./store/encrypted-store.js";

export interface Vault {
  isUnlocked(): boolean;
  unlock(passphrase: string): void;
  lock(): void;
  getSecret(key: string): string | undefined;
  setSecret(key: string, value: string): void;
  deleteSecret(key: string): boolean;
}

/**
 * Reference in-memory implementation of the Vault contract.
 */
export class InMemoryVault implements Vault {
  private readonly secrets = new Map<string, string>();
  private unlocked = false;

  isUnlocked(): boolean {
    return this.unlocked;
  }

  unlock(_passphrase: string): void {
    this.unlocked = true;
  }

  lock(): void {
    this.unlocked = false;
  }

  getSecret(key: string): string | undefined {
    this.assertUnlocked();

    return this.secrets.get(key);
  }

  setSecret(key: string, value: string): void {
    this.assertUnlocked();
    this.secrets.set(key, value);
  }

  deleteSecret(key: string): boolean {
    this.assertUnlocked();

    return this.secrets.delete(key);
  }

  private assertUnlocked(): void {
    if (!this.unlocked) {
      throw new VaultLockedError();
    }
  }
}
