# Standalone macOS runtime

Electron owns one loopback application runtime, its setup window, and only its
own local processes. The ordinary app needs no developer tools after packaging.
Current settings and credential references live in private Application Support;
macOS Keychain stores generation-addressed secrets. User-selected dedicated
workspaces hold prep and finished records. Persistence and finalization are
continuous; reasoning remains explicitly requested. A shared native lifecycle
lock excludes uninstall while the app owns state. See the
[product contract](../PRODUCT_CONTEXT.md) and [source build](../../docs/build-from-source.md).
