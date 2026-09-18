import Foundation

public let caddyBundleIdentifier = "com.frameyard.convocaddy"
public let caddyKeychainService = "com.frameyard.convocaddy"

public struct FileIdentity: Codable, Equatable, Sendable {
    public let device: UInt64
    public let inode: UInt64
    public init(device: UInt64, inode: UInt64) { self.device = device; self.inode = inode }
}

public enum WorkspaceKind: String, Codable, Sendable { case external, legacyNested, dedicated }

public struct WorkspaceTarget: Codable, Equatable, Sendable {
    public let url: URL
    public let kind: WorkspaceKind
    public let identity: FileIdentity
    public init(url: URL, kind: WorkspaceKind, identity: FileIdentity) {
        self.url = url; self.kind = kind; self.identity = identity
    }
}

public struct RemovalInventory: Codable, Equatable, Sendable {
    public let privateRoots: [URL]
    public let applicationBundles: [URL]
    public let workspaces: [WorkspaceTarget]
    public let preferencesReadable: Bool
    public let possiblyUnfinishedCapture: Bool
    public let confirmedTargetIdentities: [String: FileIdentity]
    public let evidenceDigests: [String: String]
    public init(privateRoots: [URL], applicationBundles: [URL], workspaces: [WorkspaceTarget], preferencesReadable: Bool = true, possiblyUnfinishedCapture: Bool = false, confirmedTargetIdentities: [String: FileIdentity] = [:], evidenceDigests: [String: String] = [:]) {
        self.privateRoots = privateRoots; self.applicationBundles = applicationBundles
        self.workspaces = workspaces; self.preferencesReadable = preferencesReadable
        self.possiblyUnfinishedCapture = possiblyUnfinishedCapture; self.confirmedTargetIdentities = confirmedTargetIdentities; self.evidenceDigests = evidenceDigests
    }
}

public enum InventoryError: Error, Equatable { case workspaceMovePending, unreadablePreferences, unsafePath(String), wrongBundle(String) }

public struct InventoryBuilder: Sendable {
    public init() {}
    public func validate(_ inventory: RemovalInventory, home: URL) throws {
        guard inventory.preferencesReadable else { throw InventoryError.unreadablePreferences }
        let guarder = PathGuard(home: home)
        for root in inventory.privateRoots { try guarder.requireSafeDeletionRoot(root) }
        for workspace in inventory.workspaces { try guarder.requireSafeWorkspace(workspace.url) }
        for app in inventory.applicationBundles { try guarder.requireAllowedApplication(app) }
    }
}
