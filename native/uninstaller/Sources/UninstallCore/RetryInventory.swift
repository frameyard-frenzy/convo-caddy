import Darwin
import Foundation

// A journal is discovery evidence, never renewed deletion consent. Reconcile
// before showing paths and repeat under the maintenance lock before replacing it.
public enum RetryInventory {
    public static func reconcile(_ inventory: RemovalInventory, prior: OperationJournal?, home: URL) throws -> RemovalInventory {
        guard let prior else { return inventory }
        let fs = DescriptorFileSystem(), guarder = PathGuard(home: home)
        var workspaces = inventory.workspaces
        var evidence = inventory.evidenceDigests

        func unresolved(_ url: URL) -> InventoryError {
            .unsafePath("The previous uninstall has an unverified or changed folder at \(url.path). It was left untouched; resolve this path before retrying.")
        }
        func present(_ url: URL) throws -> Bool {
            do { try guarder.requireSafeWorkspace(url) } catch { throw unresolved(url) }
            var info = stat()
            if lstat(url.path, &info) == 0 { return true }
            // Access errors and replaced ancestors are not proof of deletion.
            guard errno == ENOENT else { throw unresolved(url) }
            return false
        }
        func requireIdentity(_ url: URL, _ expected: FileIdentity) throws {
            guard (try? fs.identity(url)) == expected else { throw unresolved(url) }
        }
        func add(_ workspace: WorkspaceTarget) throws {
            let url = workspace.url
            guard try present(url) else { return }
            try requireIdentity(url, workspace.identity)
            if workspace.kind == .dedicated {
                do { try guarder.requireSafeRecursiveWorkspace(url) } catch { throw unresolved(url) }
                guard ProductionInventory.hasDedicatedOwnership(url) else { throw unresolved(url) }
                let marker = url.appendingPathComponent(".convo-caddy-workspace.json")
                guard let data = try ProductionInventory.evidenceBytes(marker) else { throw unresolved(url) }
                evidence[marker.path] = data.digest
            }
            if let current = workspaces.first(where: { $0.url.standardizedFileURL.path == url.standardizedFileURL.path || $0.identity == workspace.identity }) {
                // Never upgrade an old kept external root into deletion ownership.
                guard current.identity == workspace.identity, current.kind == workspace.kind else { throw unresolved(url) }
            } else { workspaces.append(workspace) }
        }

        // New journals retain kept paths too, so a second interruption after No
        // cannot discard discovery when there is no deletion target for that path.
        for workspace in prior.reviewedWorkspaces ?? [] { try add(workspace) }
        for target in prior.targets {
            let url = URL(fileURLWithPath: target.path)
            guard target.path.hasPrefix("/") else { throw unresolved(url) }
            guard try present(url) else { continue }
            try requireIdentity(url, target.identity)
            guard !target.complete else { throw unresolved(url) }
            if (inventory.privateRoots + inventory.applicationBundles).contains(where: { $0.standardizedFileURL.path == url.standardizedFileURL.path }) {
                continue // Current production discovery still supplies its scope.
            }
            // Compatibility with existing schema-v2 journals: an outstanding
            // non-private target must independently prove dedicated ownership.
            guard prior.workspaceChoice == .deleteDedicated else { throw unresolved(url) }
            try add(.init(url: url, kind: .dedicated, identity: target.identity))
        }
        return RemovalInventory(privateRoots: inventory.privateRoots, applicationBundles: inventory.applicationBundles,
                                workspaces: workspaces, preferencesReadable: inventory.preferencesReadable,
                                possiblyUnfinishedCapture: inventory.possiblyUnfinishedCapture,
                                confirmedTargetIdentities: inventory.confirmedTargetIdentities, evidenceDigests: evidence)
    }
}
