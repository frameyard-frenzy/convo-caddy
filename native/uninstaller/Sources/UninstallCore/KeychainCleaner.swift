import Foundation

public struct CredentialReference: Equatable, Sendable {
    public let persistentReference: Data
    public let keychainPath: String?
    public let service: String?
    public let account: String?
    public init(_ reference: Data, keychainPath: String? = nil, service: String? = nil, account: String? = nil) {
        self.persistentReference = reference
        self.keychainPath = keychainPath
        self.service = service
        self.account = account
    }
}
public enum KeychainCleanupResult: Equatable, Sendable { case complete(removed: Int); case incomplete(removed: Int, reason: String) }
public protocol KeychainPort: Sendable { func references(service: String) throws -> [CredentialReference]; func delete(reference: CredentialReference) throws }

public struct KeychainCleaner: Sendable {
    private let port: KeychainPort
    public init(port: KeychainPort) { self.port = port }
    public func clean() -> KeychainCleanupResult {
        var removed = 0
        do {
            for reference in try port.references(service: caddyKeychainService) {
                do { try port.delete(reference: reference); removed += 1 }
                catch { return .incomplete(removed: removed, reason: "Keychain entry could not be deleted: \(error.localizedDescription)") }
            }
            guard try port.references(service: caddyKeychainService).isEmpty else {
                return .incomplete(removed: removed, reason: "Some Convo Caddy passwords remain in Keychain. Try again.")
            }
            return .complete(removed: removed)
        } catch { return .incomplete(removed: removed, reason: "Keychain unavailable or access denied: \(error.localizedDescription)") }
    }
}
