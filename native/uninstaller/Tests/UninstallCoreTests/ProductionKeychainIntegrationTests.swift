import CryptoKit
import Darwin
import Foundation
import Security
import Testing
@testable import UninstallCore

// Parent-only opt-in. The disabled test does not execute any Security API.
@Suite("Opt-in production Keychain adapter")
struct ProductionKeychainIntegrationTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CADDY_RUN_SYNTHETIC_KEYCHAIN"] == "parent-reviewed"))
    func actualAdapterRemovesOnlyValidatedSyntheticItem() throws {
        let commands = SyntheticCommandRunner()
        defer { commands.finish() }
        let run = try SyntheticAdapterRun(commands: commands)
        try run.execute()
    }
}

private enum IntegrationStop: Error { case stopped(String) }
// Foundation aliases /private/tmp to /tmp even when the POSIX path is canonical.
private func canonicalPath(_ path: String) -> String? {
    guard let resolved = realpath(path, nil) else { return nil }
    defer { free(resolved) }
    return String(cString: resolved)
}

private func requireSafe(_ condition: Bool, _ phase: String) throws {
    guard condition else { throw IntegrationStop.stopped(phase) }
}

// Pure semantic classifier, tested without running getters or creating a fixture.
private func configurationFingerprint(_ domain: String, _ operation: String, _ status: Int32, _ out: Data, _ err: Data) throws -> String {
    let api = domain == "effective" ? "SecKeychainCopyDefault" : "SecKeychainCopyDomainDefault " + domain
    let absent = Data("security: \(api): A default keychain could not be found.\n".utf8)
    if operation == "default-keychain" && status == 1 && out.isEmpty && err == absent { return "absent" }
    try requireSafe(status == 0 && err.isEmpty, "configuration_getter_failed_\(domain)_\(operation)_\(status)")
    try requireSafe(operation != "default-keychain" || !String(decoding: out, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "empty_successful_default_is_ambiguous")
    return SHA256.hash(data: out).map { String(format: "%02x", $0) }.joined()
}

@Suite("Synthetic preflight semantics without Security calls")
struct SyntheticPreflightSemanticsTests {
    @Test(arguments: ["effective", "user", "system", "common"])
    func onlyExactMissingDefaultIsAbsence(domain: String) throws {
        let api = domain == "effective" ? "SecKeychainCopyDefault" : "SecKeychainCopyDomainDefault " + domain
        let absent = Data("security: \(api): A default keychain could not be found.\n".utf8)
        #expect(try configurationFingerprint(domain, "default-keychain", 1, Data(), absent) == "absent")
        #expect(throws: (any Error).self) { try configurationFingerprint(domain, "list-keychains", 1, Data(), absent) }
        #expect(throws: (any Error).self) { try configurationFingerprint(domain, "default-keychain", 1, Data(), Data("denied".utf8)) }
        #expect(throws: (any Error).self) { try configurationFingerprint(domain, "default-keychain", 0, Data(), Data()) }
    }
    @Test func successfulEmptyListHasFingerprintButFailureIsNotEmpty() throws {
        #expect(try configurationFingerprint("effective", "list-keychains", 0, Data(), Data()).count == 64)
        #expect(throws: (any Error).self) {
            try configurationFingerprint("effective", "list-keychains", 1, Data(), Data("security: SecKeychainCopySearchList: One or more parameters passed to a function were not valid.\n".utf8))
        }
    }
}

@Suite("Ordinary filesystem synthetic fixture paths")
struct SyntheticFixturePathTests {
    @Test func freshPlainDirectoryIsAccepted() throws {
        try SyntheticAdapterRun().paths()
    }
    // Literal expectations independently computed from the pinned AtomicFile SHA-1 rule.
    @Test(arguments: [".fl36DA8FA3", ".fl5D78C252"])
    func legitimateAtomicLockIsAccepted(name: String) throws {
        let run = try SyntheticAdapterRun()
        let path = run.directory + "/" + name
        try Data().write(to: URL(fileURLWithPath: path), options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o400], ofItemAtPath: path)
        try run.paths()
    }
    @Test(arguments: [".flDEADBEEF", ".fl36da8fa3", "primary.keychain-db", "foreign.keychain-db", "other.keychain"])
    func unknownCompanionsAreRejected(name: String) throws {
        let run = try SyntheticAdapterRun()
        try Data().write(to: URL(fileURLWithPath: run.directory + "/" + name))
        try FileManager.default.setAttributes([.posixPermissions: 0o400], ofItemAtPath: run.directory + "/" + name)
        #expect(throws: (any Error).self) { try run.paths() }
    }
    @Test(arguments: ["writable", "nonempty", "directory", "symlink", "hardlink"])
    func unsafeDerivedLockIsRejected(shape: String) throws {
        let run = try SyntheticAdapterRun(), fm = FileManager.default
        let path = run.directory + "/.fl36DA8FA3"
        switch shape {
        case "directory": try fm.createDirectory(atPath: path, withIntermediateDirectories: false)
        case "symlink": try fm.createSymbolicLink(atPath: path, withDestinationPath: run.directory + "/owner")
        case "hardlink": try fm.linkItem(atPath: run.directory + "/owner", toPath: path)
        default:
            try (shape == "nonempty" ? Data([0]) : Data()).write(to: URL(fileURLWithPath: path))
            try fm.setAttributes([.posixPermissions: shape == "writable" ? 0o600 : 0o400], ofItemAtPath: path)
        }
        #expect(throws: (any Error).self) { try run.paths() }
    }
    @Test(arguments: ["owner", "special-mode"])
    func unsafeMetadataIsRejectedWithoutChangingOwnershipOrSpecialBits(field: String) throws {
        let run = try SyntheticAdapterRun()
        var value = stat()
        try requireSafe(lstat(run.directory + "/owner", &value) == 0, "test_stat")
        value.st_mode = S_IFREG | 0o400
        value.st_size = 0
        if field == "owner" { value.st_uid = getuid() + 1 } else { value.st_mode |= 0o4000 }
        #expect(throws: (any Error).self) { try validateFixtureFile(value, isLock: true) }
    }

}

// AtomicFile hashes only the database basename, not its path. SHA-1 is a filename rule here.
private let syntheticLockNames = Set(["primary.keychain", "foreign.keychain"].map {
    ".fl" + Insecure.SHA1.hash(data: Data($0.utf8)).prefix(4).map { String(format: "%02X", $0) }.joined()
})

private func validateFixtureFile(_ value: stat, isLock: Bool) throws {
    try requireSafe(value.st_mode & S_IFMT == S_IFREG && value.st_uid == getuid() && value.st_nlink == 1 && value.st_mode & 0o077 == 0, "unsafe_fixture_file")
    if isLock {
        try requireSafe(value.st_mode & 0o7777 == 0o400 && value.st_size == 0, "unexpected_lock_shape")
    } else {
        try requireSafe(value.st_mode & 0o7777 == 0o600, "unexpected_fixture_mode")
    }
}

private final class SyntheticAdapterRun {
    let directory: String
    let marker: Data
    let directoryIdentity: [UInt64]
    var baseline: [String: String] = [:]
    var checkpointCount = 0
    let sentinelService = "synthetic.caddy.adapter.sentinel"
    let dummy = "SYNTHETIC-ONLY-caddy-adapter-9271"

    private let commands: SyntheticCommandRunner?

    init(commands: SyntheticCommandRunner? = nil) throws {
        self.commands = commands
        // New, private, outside HOME/Dropbox. Never accepts a caller-supplied existing fixture.
        directory = "/private/tmp/caddy-adapter-" + UUID().uuidString.lowercased()
        marker = Data(UUID().uuidString.utf8)
        try requireSafe(mkdir(directory, 0o700) == 0, "new_private_directory")
        try marker.write(to: URL(fileURLWithPath: directory + "/owner"), options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: directory + "/owner")
        directoryIdentity = try Self.identity(directory)
        print("SYNTHETIC fixture retained: \(directory)")
    }

    static func identity(_ path: String) throws -> [UInt64] {
        var value = stat()
        try requireSafe(lstat(path, &value) == 0, "lstat_failed")
        return [UInt64(value.st_dev), value.st_ino, UInt64(value.st_uid), UInt64(value.st_mode)]
    }

    func paths() throws {
        try requireSafe(try Self.identity(directory) == directoryIdentity, "owned_directory_changed")
        try requireSafe(canonicalPath(directory) == directory, "directory_symlink")
        try requireSafe(try Data(contentsOf: URL(fileURLWithPath: directory + "/owner")) == marker, "owner_changed")
        let allowed: Set<String> = ["owner", "events.jsonl", "primary.keychain", "foreign.keychain"]
        for name in try FileManager.default.contentsOfDirectory(atPath: directory) {
            try requireSafe(allowed.contains(name) || syntheticLockNames.contains(name), "unexpected_fixture_companion_stop")
            let path = directory + "/" + name
            var value = stat()
            try requireSafe(lstat(path, &value) == 0, "fixture_lstat_failed")
            try validateFixtureFile(value, isLock: syntheticLockNames.contains(name))
            try requireSafe(canonicalPath(path) == path, "fixture_symlink")
        }
        // Database inodes may change during controlled writes (AtomicFile::commit rename).
        // Only the two derived lock companions are allowed. No resumed adoption or cleanup.
    }

    func emit(_ event: [String: Any]) throws {
        try paths()
        var data = try JSONSerialization.data(withJSONObject: event, options: .sortedKeys)
        data.append(10)
        let path = directory + "/events.jsonl"
        let fd = Darwin.open(path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600)
        try requireSafe(fd >= 0, "event_open_failed")
        defer { Darwin.close(fd) }
        let count = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
        try requireSafe(count == data.count, "event_write_failed")
    }

    func command(_ arguments: [String]) throws -> (Int32, Data, Data) {
        guard let commands else { throw SyntheticCommandError.stopped }
        return try commands.command("/usr/bin/security", arguments)
    }

    func checkpoint(_ phase: String) throws {
        try paths()
        var snapshot: [String: String] = [:]
        for domain in ["effective", "user", "system", "common"] {
            for operation in ["list-keychains", "default-keychain"] {
                let args = [operation] + (domain == "effective" ? [] : ["-d", domain])
                let (status, out, err) = try command(args)
                snapshot[domain + ":" + operation] = try configurationFingerprint(domain, operation, status, out, err)
            }
        }
        if baseline.isEmpty { baseline = snapshot }
        try emit(["event": "configuration", "phase": phase, "equal": snapshot == baseline, "fingerprints": snapshot])
        try requireSafe(snapshot == baseline, "configuration_changed_stop_no_restore")
        checkpointCount += 1
    }

    func operation<T>(_ phase: String, _ body: () throws -> T) throws -> T {
        try checkpoint("before_" + phase)
        do {
            let value = try body()
            try checkpoint("after_" + phase)
            return value
        } catch let error as SyntheticCommandError {
            // Timeout/denial has uncertain mutation state: no follow-up getter or retry.
            throw error
        } catch {
            // Metadata checkpoint only, then fail-stop; never cleanup or a compensating setter.
            try checkpoint("failed_" + phase)
            throw error
        }
    }

    func create(_ name: String) throws -> SecKeychain {
        let path = directory + "/" + name + ".keychain"
        try requireSafe(!path.contains("login.keychain") && !path.contains("/System/") && !FileManager.default.fileExists(atPath: path), "private_creation_path")
        return try operation("create_" + name) {
            var keychain: SecKeychain?
            let bytes = Data(dummy.utf8)
            let status = bytes.withUnsafeBytes { SecKeychainCreate(path, UInt32($0.count), $0.baseAddress, false, nil, &keychain) }
            try requireSafe(status == errSecSuccess, "create_status_\(status)")
            guard let keychain else { throw IntegrationStop.stopped("create_missing_handle") }
            try verifyPath(keychain, path)
            return keychain
        }
    }

    func verifyPath(_ keychain: SecKeychain, _ expected: String) throws {
        var buffer = [CChar](repeating: 0, count: 4096), length: UInt32 = 4096
        try requireSafe(SecKeychainGetPath(keychain, &length, &buffer) == errSecSuccess, "resolved_path_failed")
        try requireSafe(String(cString: buffer) == expected, "resolved_path_mismatch_stop")
        try paths()
    }

    func add(_ keychain: SecKeychain, _ name: String, _ service: String, _ account: String) throws {
        let path = directory + "/" + name + ".keychain"
        try operation("insert_" + name + "_" + account) {
            try verifyPath(keychain, path)
            // SecurityTool is the creator, this test executable is a distinct consumer.
            // Fresh add only: no -U default fallback, -A/-T ACL override, unlock or prompt.
            let (status, out, err) = try command(["add-generic-password", "-s", service, "-a", account, "-w", dummy, path])
            try requireSafe(status == 0 && out.isEmpty && err.isEmpty, "insert_failed_\(status)")
            try verifyPath(keychain, path)
        }
    }

    func sentinel(_ keychain: SecKeychain) throws -> Data {
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: sentinelService,
            kSecAttrAccount: "sentinel", kSecMatchSearchList: [keychain], kSecReturnPersistentRef: true, kSecMatchLimit: kSecMatchLimitAll]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        try requireSafe(status == errSecSuccess, "sentinel_query_\(status)")
        guard let refs = result as? [Data], refs.count == 1 else { throw IntegrationStop.stopped("sentinel_ambiguous") }
        return refs[0]
    }

    func rejected(_ phase: String, _ body: () throws -> Void) throws {
        try operation(phase) {
            do { try body() } catch is CredentialRemovalError {
                try emit(["event": "rejection", "phase": phase, "passed": true]); return
            }
            throw IntegrationStop.stopped("expected_identity_rejection_" + phase)
        }
    }

    func execute() throws {
        try checkpoint("preflight")
        // Process-local UI suppression, never alters ACLs or host configuration.
        try requireSafe(SecKeychainSetUserInteractionAllowed(false) == errSecSuccess, "ui_suppression_failed")
        let primary = try create("primary"), foreign = try create("foreign")
        try add(primary, "primary", caddyKeychainService, "target")
        try add(primary, "primary", sentinelService, "sentinel")
        try add(foreign, "foreign", caddyKeychainService, "target")
        let port = SecurityKeychainPort(keychain: primary), foreignPort = SecurityKeychainPort(keychain: foreign)
        let refs = try operation("production_discovery") { try port.references(service: caddyKeychainService) }
        try requireSafe(refs.count == 1, "target_count")
        let target = refs[0]
        let kept = try operation("sentinel_baseline") { try sentinel(primary) }
        let foreignRefs = try operation("foreign_discovery") { try foreignPort.references(service: caddyKeychainService) }
        try requireSafe(foreignRefs.count == 1, "foreign_count")
        try rejected("wrong_service") { try port.delete(reference: .init(kept, keychainPath: target.keychainPath, service: caddyKeychainService, account: "sentinel")) }
        try rejected("wrong_account") { try port.delete(reference: .init(target.persistentReference, keychainPath: target.keychainPath, service: caddyKeychainService, account: "wrong")) }
        try rejected("foreign_keychain") { try port.delete(reference: foreignRefs[0]) }
        try operation("RED_old_selector") {
            let query: [CFString: Any] = [kSecValuePersistentRef: target.persistentReference, kSecMatchSearchList: [primary]]
            let status = SecItemDelete(query as CFDictionary)
            try emit(["event": "RED", "status": status])
            try requireSafe(status == errSecInvalidOwnerEdit, "unexpected_RED_status_stop")
        }
        try operation("RED_postconditions") {
            try requireSafe(try port.references(service: caddyKeychainService) == refs && sentinel(primary) == kept, "RED_postcondition")
        }
        try operation("GREEN_actual_adapter") {
            try port.delete(reference: target)
            try emit(["event": "GREEN", "status": 0, "actual_adapter": true])
        }
        try operation("GREEN_postconditions") {
            try requireSafe(try port.references(service: caddyKeychainService).isEmpty && sentinel(primary) == kept && foreignPort.references(service: caddyKeychainService) == foreignRefs, "GREEN_postcondition")
        }
        try operation("stale_reference") { try port.delete(reference: target) }
        try operation("already_empty_cleaner") {
            try requireSafe(KeychainCleaner(port: port).clean() == .complete(removed: 0), "empty_cleaner_result")
        }
        try operation("final_preservation_after_retry_and_cleaner") {
            try requireSafe(try port.references(service: caddyKeychainService).isEmpty && sentinel(primary) == kept && foreignPort.references(service: caddyKeychainService) == foreignRefs, "final_preservation_postcondition")
        }
        try checkpoint("final")
        try emit(["event": "PASS", "actual_adapter": true, "sentinel_unchanged": true, "foreign_unchanged": true, "equal_checkpoints": checkpointCount])
        print("PASS actual production adapter; fixtures retained; equal checkpoints: \(checkpointCount)")
    }
}
