export interface Vault {
  isUnlocked(): boolean;
  unlock(passphrase: string): void;
  lock(): void;
  getSecret(key: string): string | undefined;
  setSecret(key: string, value: string): void;
  deleteSecret(key: string): boolean;
}

export class VaultLockedError extends Error {
  constructor() {
    super("Vault is locked: unlock it before accessing secrets");
    this.name = "VaultLockedError";
  }
}

/**
 * Reference in-memory implementation of the Vault contract.
 * Production adapters should back this with the OS keychain or an
 * encrypted store; the interface stays the same.
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
