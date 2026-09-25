import Foundation

public struct UninstallDialog: Equatable {
    public let title: String
    public let detail: String
    public let buttons: [String]
    public let defaultButton: Int
    public init(_ title: String, _ detail: String, buttons: [String] = ["OK"], defaultButton: Int = 0) {
        self.title=title;self.detail=detail;self.buttons=buttons;self.defaultButton=defaultButton
    }
}

@MainActor public protocol UninstallDialogUI {
    func ask(_ dialog: UninstallDialog) -> Int
    func show(_ dialog: UninstallDialog)
    func chooseWorkspacePreservation() -> URL?
}

@MainActor public enum UninstallFlow {
    public static func run(ui: UninstallDialogUI, home: URL, inventory: () throws -> RemovalInventory,
                           journal: JournalPort, processes: ProcessPort,
                           execute: (UninstallRequest) -> UninstallOutcome) {
        do {
            let previous=try journal.load()
            let interrupted=previous != nil
            let current=try RetryInventory.reconcile(inventory(),prior:previous,home:home)
            guard current.preferencesReadable else {ui.show(.init("Cannot uninstall", "The saved workspace path cannot be read. Repair the workspace preferences and try again."));return}
            guard processes.currentAppProcesses().isEmpty && processes.legacyOrUnknownProcesses().isEmpty else {
                ui.show(.init("Quit Convo Caddy first", "Quit the app normally, then reopen the uninstaller."));return
            }
            var details="Uninstall Convo Caddy and remove its private app data and saved credentials."
            if !current.workspaces.isEmpty {
                details += "\n\n" + current.workspaces.map(\.url.path).joined(separator:"\n")
                details += current.workspaces.allSatisfy({$0.kind == .dedicated})
                    ? "\nYes permanently deletes the entire folder. No keeps it."
                    : "\nThis older workspace can only be kept. Choose No to uninstall."
            }
            if current.possiblyUnfinishedCapture {details += "\n\nA recording may still be running. Check the meeting app; uninstall does not stop it."}
            if interrupted {details += "\n\nThe previous uninstall was interrupted. Choose again to finish removing the remaining items."}
            let hasWorkspace = !current.workspaces.isEmpty
            let response=ui.ask(hasWorkspace
                ? .init("Also delete your workspace?",details,buttons:["No","Yes","Cancel"])
                : .init("Uninstall Convo Caddy",details,buttons:["Uninstall","Cancel"]))
            guard response == 0 || (hasWorkspace && response == 1) else{return}
            let deleteWorkspace=hasWorkspace && response == 1
            if deleteWorkspace && !current.workspaces.allSatisfy({$0.kind == .dedicated}) {
                ui.show(.init("Workspace cannot be deleted", "This older folder is not verified as a dedicated Caddy workspace. Choose No to uninstall and keep it."));return
            }
            var destination:URL?
            if (!deleteWorkspace && UninstallReviewModel.needsPreservation(current)) || previous?.preservation.contains(where:{$0.receipt == nil}) == true {
                guard let selected=ui.chooseWorkspacePreservation() else{return};destination=selected
            }
            let outcome=execute(.init(inventory:current,choice:deleteWorkspace ? .deleteDedicated : .keep,confirmed:true,destructiveWorkspaceConfirmed:deleteWorkspace,preservationDestination:destination,interruptedOperationAcknowledged:interrupted))
            switch outcome {
            case let .complete(retained,_):ui.show(.init("Convo Caddy uninstalled",retained.isEmpty ? "" : "Workspace kept:\n" + retained.map(\.path).joined(separator:"\n")))
            case let .blocked(reason):ui.show(.init("Removal blocked",reason))
            case let .incomplete(reason):ui.show(.init("Uninstall incomplete",reason + "\nSome items may already be removed. Fix the problem and run the uninstaller again."))
            }
        } catch InventoryError.workspaceMovePending { ui.show(.init("Finish workspace recovery first", "Open Convo Caddy to recover the interrupted workspace move, then quit it and reopen the uninstaller. Keep both workspace folders until recovery finishes."))
        } catch { ui.show(.init("Removal blocked","Local files could not be read safely: \(error)")) }
    }
}
