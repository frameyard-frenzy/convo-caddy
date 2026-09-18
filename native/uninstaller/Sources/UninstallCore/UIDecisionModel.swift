import Foundation

public enum WorkspaceDecision: Equatable, Sendable { case keep, reviewDeletion(paths: [URL]) }
public struct UninstallReviewModel: Equatable, Sendable {
    public var deleteWorkspace = false
    public init() {}
    public func decision(paths: [URL]) -> WorkspaceDecision { deleteWorkspace ? .reviewDeletion(paths: paths) : .keep }
    public static func needsPreservation(_ inventory: RemovalInventory) -> Bool {
        inventory.workspaces.contains { workspace in inventory.privateRoots.contains { workspacePathContains($0,workspace.url) } }
    }
    public static func progressText(_ phase: OperationPhase) -> String {
        switch phase {
        case .preserving, .preserved: return "Saving your workspace…"
        case .verifying, .complete: return "Finishing uninstall…"
        case .incomplete: return "Uninstall stopped"
        default: return "Removing Convo Caddy…"
        }
    }
    public var primaryLabel: String { "Remove local app data" }
    public var workspacePrompt: String { "Delete saved prep and finished conversations?" }
    public var defaultWorkspaceAnswer: String { "No" }
}
