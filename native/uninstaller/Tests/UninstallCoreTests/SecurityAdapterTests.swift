import Foundation
import Security
import Testing
@testable import UninstallCore

/// All Security calls are injected. This suite never creates, opens or queries a host keychain.
private final class FakeSecurity: @unchecked Sendable {
    var remaining = Set([Data([1]), Data([2])])
    var deleted: [String] = []
    var queries = 0
    var openedKeychains = 0
    var resolvingDeletion = false
    var invalidRows: CFTypeRef?
    var malformed = false
    var enumerationStatus: OSStatus = errSecSuccess
    var resolutionStatus: OSStatus = errSecSuccess
    var deletionStatus: OSStatus = errSecSuccess
    var retainAfterDelete = false
    var duplicateResolution = false
    var metadataFailure: Error?
    var classCode: UInt32 = 0x67656e70
    var metadataService = caddyKeychainService
    var metadataAccount: String?
    var metadataPath = "/synthetic/owned.keychain"
    var missingDuringResolution = false
    var failSecond = false
    var duplicateRows = false
    var openedPath: String?
    var openFailure: Error?
    var malformedResolution = false
    let path = "/synthetic/owned.keychain"

    func makePort(scoped: Bool = false) -> SecurityKeychainPort {
        SecurityKeychainPort(calls: .init(copyMatching: { [self] query in
            queries += 1
            #expect(query[kSecReturnData] == nil)
            if let reference = query[kSecValuePersistentRef] as? Data {
                #expect(query[kSecReturnRef] as? Bool == true)
                #expect(query[kSecMatchLimit] as? String == kSecMatchLimitAll as String)
                if resolvingDeletion || scoped {
                    #expect(query[kSecMatchSearchList] as? [String] == ["owned-keychain"])
                }
                if resolutionStatus != errSecSuccess { return (resolutionStatus, nil) }
                if malformedResolution { return (errSecSuccess, nil) }
                if missingDuringResolution || !remaining.contains(reference) { return (errSecItemNotFound, nil) }
                let item = "item-\(reference[0])" as CFString
                return (errSecSuccess, (duplicateResolution ? [item,item] : [item]) as CFArray)
            }
            resolvingDeletion = false
            #expect(query[kSecClass] as? String == kSecClassGenericPassword as String)
            #expect(query[kSecAttrService] as? String == caddyKeychainService)
            #expect(query[kSecReturnPersistentRef] as? Bool == true)
            #expect(query[kSecReturnAttributes] as? Bool == true)
            if scoped { #expect(query[kSecMatchSearchList] != nil) }
            if enumerationStatus != errSecSuccess { return (enumerationStatus,nil) }
            if malformed { return (errSecSuccess,invalidRows) }
            if remaining.isEmpty { return (errSecItemNotFound,nil) }
            var rows = remaining.sorted { $0[0] < $1[0] }.map { ref in
                [kSecValuePersistentRef: ref, kSecAttrService: caddyKeychainService, kSecAttrAccount: "account-\(ref[0])"] as [CFString: Any]
            }
            if duplicateRows { rows.append(rows[0]) }
            return (errSecSuccess,rows as CFArray)
        }, openKeychain: { [self] path in
            #expect(path == self.path)
            if let openFailure { throw openFailure }
            openedKeychains += 1
            resolvingDeletion = true
            return "owned-keychain" as CFString
        }, keychainPath: { [self] _ in openedPath ?? path }, metadata: { [self] value in
            if let metadataFailure { throw metadataFailure }
            let name = value as! String
            return LegacyCredentialMetadata(itemClass: classCode, service: Data(metadataService.utf8),
                account: Data((metadataAccount ?? name.replacingOccurrences(of: "item", with: "account")).utf8), keychainPath: metadataPath)
        }, deleteLegacyItem: { [self] value in
            let name = value as! String
            deleted.append(name)
            if failSecond && name == "item-2" { return errSecAuthFailed }
            if deletionStatus == errSecSuccess || deletionStatus == errSecItemNotFound {
                if !retainAfterDelete { remaining.remove(Data([UInt8(name.suffix(1))!])) }
            }
            return deletionStatus
        }), keychain: scoped ? "owned-keychain" as CFString : nil)
    }
    func reference(_ n: UInt8 = 1, service: String = caddyKeychainService, account: String? = nil, keychainPath: String? = nil) -> CredentialReference {
        .init(Data([n]), keychainPath: keychainPath ?? path, service: service, account: account ?? "account-\(n)")
    }
}

@Suite("Metadata-only Security adapter")
struct SecurityAdapterTests {
    @Test func unprovenReferenceCannotAuthorizeDeletion() {
        let fake = FakeSecurity(); let port = fake.makePort()
        #expect(throws: (any Error).self) { try port.delete(reference: .init(Data([3]))) }
        #expect(fake.deleted.isEmpty)
    }
    @Test func unrelatedServiceIsRejectedBeforeQuery() {
        let fake = FakeSecurity(); let port = fake.makePort()
        #expect(throws: (any Error).self) { try port.references(service: "unrelated.synthetic") }
        #expect(fake.queries == 0)
    }
    @Test func discoveryCapturesValidatedAccountAndProvenance() throws {
        let fake = FakeSecurity(); let refs = try fake.makePort().references(service: caddyKeychainService)
        #expect(refs == [fake.reference(1),fake.reference(2)])
        #expect(fake.deleted.isEmpty)
    }
    @Test func validatedReferenceUsesExactLegacyDeleteAndChecksAbsence() throws {
        let fake = FakeSecurity(); let port = fake.makePort(scoped: true)
        let ref = try #require(port.references(service: caddyKeychainService).first)
        try port.delete(reference: ref)
        #expect(fake.deleted == ["item-1"])
        #expect(fake.remaining == [Data([2])])
    }
    @Test(arguments: [errSecSuccess, errSecItemNotFound])
    func alreadyMissingDeletionIsIdempotent(status: OSStatus) throws {
        let fake = FakeSecurity(); fake.deletionStatus = status
        let port = fake.makePort(); try port.delete(reference: fake.reference())
        try port.delete(reference: fake.reference())
        #expect(fake.deleted == ["item-1"])
    }
    @Test func firstDeletionResolutionHasExactSingletonScopeFromUnscopedPort() throws {
        let fake = FakeSecurity()
        try fake.makePort().delete(reference: fake.reference())
        #expect(fake.openedKeychains == 1)
        #expect(fake.queries == 2) // initial resolution and exact absence verification
        #expect(fake.deleted == ["item-1"])
    }
    @Test func missingAtResolutionIsIdempotent() throws {
        let fake = FakeSecurity(); fake.missingDuringResolution = true
        try fake.makePort().delete(reference: fake.reference())
        #expect(fake.deleted.isEmpty)
        #expect(try fake.makePort().references(service: caddyKeychainService).isEmpty)
    }
    @Test(arguments: [0,1,2,3,4])
    func malformedSuccessIsNotAbsence(shape: Int) {
        let fake = FakeSecurity(); fake.malformed = true
        switch shape {
        case 0: fake.invalidRows = nil
        case 1: fake.invalidRows = "wrong" as CFString
        case 2: fake.invalidRows = [] as CFArray
        case 3: fake.invalidRows = [[kSecValuePersistentRef: Data([1]), kSecAttrService: caddyKeychainService]] as CFArray
        default: fake.invalidRows = [[kSecValuePersistentRef: Data([1]), kSecAttrService: "wrong", kSecAttrAccount: "account-1"]] as CFArray
        }
        guard case .incomplete = KeychainCleaner(port: fake.makePort()).clean() else { Issue.record("Malformed evidence must fail closed"); return }
        #expect(fake.deleted.isEmpty)
    }
    @Test(arguments: ["class","service","account","path","backend"])
    func changedMetadataIsRejectedBeforeDelete(field: String) {
        let fake = FakeSecurity()
        switch field {
        case "class": fake.classCode = 0x696e6574
        case "service": fake.metadataService = "unrelated"
        case "account": fake.metadataAccount = "someone-else"
        case "path": fake.metadataPath = "/synthetic/other.keychain"
        default: fake.metadataFailure = CredentialRemovalError.unsupportedBackend
        }
        #expect(throws: (any Error).self) { try fake.makePort().delete(reference: fake.reference()) }
        #expect(fake.deleted.isEmpty)
    }
    @Test func foreignKeychainRejectedByExplicitScopeBeforeQuery() {
        let fake = FakeSecurity()
        #expect(throws: (any Error).self) { try fake.makePort(scoped: true).delete(reference: fake.reference(keychainPath: "/synthetic/other.keychain")) }
        #expect(fake.queries == 0); #expect(fake.deleted.isEmpty)
    }
    @Test func discoveryRejectsForeignProvenanceInExplicitScope() {
        let fake = FakeSecurity(); fake.metadataPath = "/synthetic/other.keychain"
        #expect(throws: (any Error).self) { try fake.makePort(scoped: true).references(service: caddyKeychainService) }
        #expect(fake.deleted.isEmpty)
    }
    @Test func duplicateDiscoveryAndAmbiguousResolutionFailClosed() {
        let fake = FakeSecurity(); fake.duplicateRows = true
        #expect(throws: (any Error).self) { try fake.makePort().references(service: caddyKeychainService) }
        fake.duplicateRows = false; fake.duplicateResolution = true
        #expect(throws: (any Error).self) { try fake.makePort().delete(reference: fake.reference()) }
        #expect(fake.deleted.isEmpty)
    }
    @Test(arguments: [errSecAuthFailed,errSecInteractionNotAllowed,errSecInvalidItemRef])
    func resolutionErrorsNeverBecomeAbsence(status: OSStatus) {
        let fake = FakeSecurity(); fake.resolutionStatus = status
        #expect(throws: (any Error).self) { try fake.makePort().delete(reference: fake.reference()) }
        #expect(fake.deleted.isEmpty)
    }
    @Test func openedKeychainMustMatchRecordedProvenance() {
        let fake = FakeSecurity(); fake.openedPath = "/synthetic/other.keychain"
        #expect(throws: (any Error).self) { try fake.makePort().delete(reference: fake.reference()) }
        #expect(fake.queries == 0); #expect(fake.deleted.isEmpty)
    }
    @Test func failedOpenCannotFallBackToDefault() {
        let fake = FakeSecurity(); fake.openFailure = NSError(domain: NSOSStatusErrorDomain, code: Int(errSecAuthFailed))
        #expect(throws: (any Error).self) { try fake.makePort().delete(reference: fake.reference()) }
        #expect(fake.queries == 0); #expect(fake.deleted.isEmpty)
    }
    @Test func malformedResolutionCannotBecomeMissing() {
        let fake = FakeSecurity(); fake.malformedResolution = true
        #expect(throws: (any Error).self) { try fake.makePort().delete(reference: fake.reference()) }
        #expect(fake.deleted.isEmpty)
    }
    @Test func unavailableEnumerationCannotReportComplete() {
        let fake = FakeSecurity(); fake.enumerationStatus = errSecInteractionNotAllowed
        guard case .incomplete(removed: 0, _) = KeychainCleaner(port: fake.makePort()).clean() else { Issue.record("Unavailable is not absent"); return }
        #expect(fake.deleted.isEmpty)
    }
    @Test func apparentSuccessWithRemainingItemIsIncomplete() {
        let fake = FakeSecurity(); fake.retainAfterDelete = true
        #expect(throws: CredentialRemovalError.itemRemains) { try fake.makePort().delete(reference: fake.reference()) }
        #expect(fake.remaining.contains(Data([1])))
    }
    @Test func failurePreservesPartialCountAndOtherItems() {
        let fake = FakeSecurity(); fake.failSecond = true
        guard case .incomplete(let removed, let reason) = KeychainCleaner(port: fake.makePort()).clean() else { Issue.record("Must report partial failure"); return }
        #expect(removed == 1); #expect(fake.remaining == [Data([2])]); #expect(reason.contains("Keychain entry could not be deleted"))
    }
    @Test func cleanerVerifiesCompleteAfterAllExactDeletions() {
        let fake = FakeSecurity()
        #expect(KeychainCleaner(port: fake.makePort()).clean() == .complete(removed: 2))
        #expect(fake.deleted == ["item-1","item-2"])
    }
}
