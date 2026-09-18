# Exact Keychain deletion

Confirmed uninstall discovers only Caddy's exact generic-password service.
Each reference retains account and owning-Keychain provenance. The native
adapter resolves and validates a persistent reference before exact-item deletion,
then verifies absence. It never reads secret data, broadens to a service-wide
delete, alters ACLs, or falls back to another Keychain. Only item-not-found is
idempotent absence; access failures and invalid references remain incomplete.

Fake-native tests exercise identity, malformed results, duplicates and failure
boundaries. The [opt-in integration harness](../../native/uninstaller/Integration/README.md)
uses separately authorized disposable Keychains. Source tests do not establish
real Keychain, installed-binary or user-machine acceptance.
