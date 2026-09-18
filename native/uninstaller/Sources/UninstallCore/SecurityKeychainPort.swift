import Foundation
#if canImport(Security)
import Security

/// Metadata only; neither the production calls nor the injected seams return password data.
struct LegacyCredentialMetadata: Equatable, Sendable {
    let itemClass: UInt32
    let service: Data
    let account: Data
    let keychainPath: String
}

struct KeychainSecurityCalls: Sendable {
    let copyMatching: @Sendable ([CFString: Any]) -> (OSStatus, CFTypeRef?)
    let openKeychain: @Sendable (String) throws -> CFTypeRef
    let keychainPath: @Sendable (CFTypeRef) throws -> String
    let metadata: @Sendable (CFTypeRef) throws -> LegacyCredentialMetadata
    let deleteLegacyItem: @Sendable (CFTypeRef) -> OSStatus
}

enum CredentialRemovalError: Error, LocalizedError {
    case unverifiedIdentity, unsupportedBackend, itemRemains
    var errorDescription: String? {
        switch self {
        case .unverifiedIdentity:
            return "The saved credential's exact identity could not be verified. Keep this message and retry with the supported uninstaller; no broader Keychain deletion was attempted."
        case .unsupportedBackend:
            return "This credential is not a supported legacy file-Keychain item. Removal is incomplete; keep this message for support."
        case .itemRemains:
            return "The exact credential remains after deletion. Removal is incomplete; keep this message before retrying."
        }
    }
}

// Retained immutable Core Foundation scope, shared under Security.framework's thread-safe APIs.
private struct SearchScope: @unchecked Sendable { let keychain: CFTypeRef }

public struct SecurityKeychainPort: KeychainPort, Sendable {
    private let calls: KeychainSecurityCalls
    private let scope: SearchScope?

    public init() { self.init(calls: .live) }

    /// Explicit scope for isolated integration; never falls back to the host's search list.
    public init(keychain: SecKeychain) { self.init(calls: .live, keychain: keychain) }

    init(calls: KeychainSecurityCalls, keychain: CFTypeRef? = nil) {
        self.calls = calls
        self.scope = keychain.map { SearchScope(keychain: $0) }
    }

    public func references(service: String) throws -> [CredentialReference] {
        guard service == caddyKeychainService else { throw CredentialRemovalError.unverifiedIdentity }
        var query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword, kSecAttrService: service,
            kSecMatchLimit: kSecMatchLimitAll, kSecReturnPersistentRef: true, kSecReturnAttributes: true,
        ]
        if let scope { query[kSecMatchSearchList] = [scope.keychain] }
        let (status, result) = calls.copyMatching(query)
        if status == errSecItemNotFound { return [] }
        try check(status)
        guard let rows = result as? [[CFString: Any]], !rows.isEmpty else { throw CredentialRemovalError.unverifiedIdentity }
        var seen = Set<Data>()
        return try rows.compactMap { row in
            guard let ref = row[kSecValuePersistentRef] as? Data, !ref.isEmpty,
                  seen.insert(ref).inserted,
                  row[kSecAttrService] as? String == service,
                  let account = row[kSecAttrAccount] as? String, !account.isEmpty else {
                throw CredentialRemovalError.unverifiedIdentity
            }
            // A concurrently removed reference is already absent; other errors are never skipped.
            guard let item = try resolve(ref, keychain: scope?.keychain) else { return nil }
            let metadata = try calls.metadata(item)
            try validate(metadata, service: service, account: account)
            try validateScope(metadata.keychainPath)
            return CredentialReference(ref, keychainPath: metadata.keychainPath, service: service, account: account)
        }
    }

    public func delete(reference: CredentialReference) throws {
        guard !reference.persistentReference.isEmpty,
              reference.service == caddyKeychainService,
              let account = reference.account, !account.isEmpty,
              let path = reference.keychainPath, validPath(path) else {
            throw CredentialRemovalError.unverifiedIdentity
        }
        try validateScope(path)
        let keychain = try calls.openKeychain(path)
        guard try calls.keychainPath(keychain) == path else { throw CredentialRemovalError.unverifiedIdentity }
        guard let item = try resolve(reference.persistentReference, keychain: keychain) else { return }
        let metadata = try calls.metadata(item)
        try validate(metadata, service: caddyKeychainService, account: account)
        guard metadata.keychainPath == path else { throw CredentialRemovalError.unverifiedIdentity }
        // Public legacy exact-item API used by SecurityTool. No SecItemDelete/CLI/ACL fallback.
        let status = calls.deleteLegacyItem(item)
        guard status == errSecSuccess || status == errSecItemNotFound else { try check(status); return }
        guard try resolve(reference.persistentReference, keychain: keychain) == nil else {
            throw CredentialRemovalError.itemRemains
        }
    }

    private func resolve(_ ref: Data, keychain: CFTypeRef?) throws -> CFTypeRef? {
        var query: [CFString: Any] = [kSecValuePersistentRef: ref, kSecReturnRef: true, kSecMatchLimit: kSecMatchLimitAll]
        if let keychain { query[kSecMatchSearchList] = [keychain] }
        let (status, result) = calls.copyMatching(query)
        if status == errSecItemNotFound { return nil }
        try check(status)
        guard let items = result as? [CFTypeRef], items.count == 1 else { throw CredentialRemovalError.unverifiedIdentity }
        return items[0]
    }

    private func validate(_ metadata: LegacyCredentialMetadata, service: String, account: String) throws {
        guard metadata.itemClass == 0x67656e70, // 'genp', public SecItemClass
              metadata.service == Data(service.utf8), metadata.account == Data(account.utf8),
              validPath(metadata.keychainPath) else { throw CredentialRemovalError.unverifiedIdentity }
    }

    private func validateScope(_ path: String) throws {
        if let scope, try calls.keychainPath(scope.keychain) != path { throw CredentialRemovalError.unverifiedIdentity }
    }

    private func validPath(_ path: String) -> Bool { path.hasPrefix("/") && path != "/" && !path.utf8.contains(0) }
    private func check(_ status: OSStatus) throws {
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }
}

private func legacyKeychainPath(_ value: CFTypeRef) throws -> String {
    guard CFGetTypeID(value) == SecKeychainGetTypeID() else { throw CredentialRemovalError.unsupportedBackend }
    var path = [CChar](repeating: 0, count: 4096), length: UInt32 = 4096
    let status = SecKeychainGetPath(value as! SecKeychain, &length, &path)
    guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    return String(cString: path)
}

extension KeychainSecurityCalls {
    static let live = KeychainSecurityCalls(copyMatching: { query in
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        return (status, result)
    }, openKeychain: { path in
        var keychain: SecKeychain?
        let status = SecKeychainOpen(path, &keychain)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        guard let keychain else { throw CredentialRemovalError.unverifiedIdentity }
        return keychain
    }, keychainPath: legacyKeychainPath, metadata: { value in
        guard CFGetTypeID(value) == SecKeychainItemGetTypeID() else { throw CredentialRemovalError.unsupportedBackend }
        let item = value as! SecKeychainItem
        var keychain: SecKeychain?
        var status = SecKeychainItemCopyKeychain(item, &keychain)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        guard let keychain else { throw CredentialRemovalError.unsupportedBackend }
        let path = try legacyKeychainPath(keychain)
        var tags: [UInt32] = [0x73766365, 0x61636374] // 'svce', 'acct', public SecKeychainItem.h
        var itemClass = SecItemClass(rawValue: 0x67656e70)!
        var attributes: UnsafeMutablePointer<SecKeychainAttributeList>?
        status = tags.withUnsafeMutableBufferPointer { buffer in
            var info = SecKeychainAttributeInfo(count: 2, tag: buffer.baseAddress!, format: nil)
            return SecKeychainItemCopyAttributesAndData(item, &info, &itemClass, &attributes, nil, nil)
        }
        defer { if let attributes { SecKeychainItemFreeAttributesAndData(attributes, nil) } }
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        guard let attributes, attributes.pointee.count == 2, let attrs = attributes.pointee.attr else {
            throw CredentialRemovalError.unverifiedIdentity
        }
        var values: [UInt32: Data] = [:]
        for index in 0..<2 {
            let attribute = attrs[index]
            guard let bytes = attribute.data, attribute.length > 0, values[attribute.tag] == nil else {
                throw CredentialRemovalError.unverifiedIdentity
            }
            values[attribute.tag] = Data(bytes: bytes, count: Int(attribute.length))
        }
        guard let service = values[tags[0]], let account = values[tags[1]] else { throw CredentialRemovalError.unverifiedIdentity }
        return LegacyCredentialMetadata(itemClass: itemClass.rawValue, service: service, account: account, keychainPath: path)
    }, deleteLegacyItem: { item in
        guard CFGetTypeID(item) == SecKeychainItemGetTypeID() else { return errSecParam }
        return SecKeychainItemDelete(item as! SecKeychainItem)
    })
}
#endif
