/**
 * @orbital/vault — encrypted secret store for the Orbital ecosystem.
 *
 * Library surface: the {@link Vault} contract, the in-memory reference
 * implementation, and the AES-256-GCM SQLite-backed persistent vault with
 * credential-injection helpers.
 */

export { InMemoryVault, type Vault } from "./in-memory.js";

export {
  DEFAULT_VAULT_PATH,
  EncryptedStore,
  VaultAuthError,
  VaultLockedError
} from "./store/encrypted-store.js";

export { SqliteVault, type SqliteVaultOptions } from "./vault.js";
