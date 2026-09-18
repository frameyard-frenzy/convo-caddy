import AppKit
import Foundation
import UninstallCore

final class CancellationState: @unchecked Sendable {
    private let lock=NSLock();private var cancelled=false
    func request(){lock.lock();cancelled=true;lock.unlock()}
    func value()->Bool{lock.lock();defer{lock.unlock()};return cancelled}
}
@MainActor final class RemovalProgress: NSObject, CancellationPort, @unchecked Sendable {
    nonisolated private let state=CancellationState()
    let window: NSWindow; private let label: NSTextField
    override init() {
        window=NSWindow(contentRect:NSRect(x:0,y:0,width:460,height:150),styleMask:[.titled],backing:.buffered,defer:false)
        window.title="Uninstalling Convo Caddy"
        let content=NSView(frame:window.contentView!.bounds)
        label=NSTextField(labelWithString:"Removing Convo Caddy…"); label.frame=NSRect(x:24,y:92,width:412,height:24)
        let indicator=NSProgressIndicator(frame:NSRect(x:24,y:62,width:412,height:18)); indicator.style = .bar; indicator.isIndeterminate=true; indicator.startAnimation(nil)
        let cancel=NSButton(title:"Cancel",target:nil,action:nil); cancel.frame=NSRect(x:220,y:18,width:216,height:32)
        content.addSubview(label);content.addSubview(indicator);content.addSubview(cancel);window.contentView=content
        super.init();cancel.target=self;cancel.action=#selector(cancelRequested)
    }
    @objc private func cancelRequested(){state.request();label.stringValue="Cancelling…"}
    nonisolated func isCancelled() -> Bool {state.value()}
    func reached(_ phase: OperationPhase) {
        label.stringValue=UninstallReviewModel.progressText(phase)
        // Dispatch actual AppKit events, not just Foundation timers. The
        // synchronous coordinator yields here before every deletion target.
        while let event = NSApplication.shared.nextEvent(matching: .any, until: Date(), inMode: .default, dequeue: true) {
            NSApplication.shared.sendEvent(event)
        }
        NSApplication.shared.updateWindows()
    }
}

@main @MainActor struct UninstallConvoCaddyApp {
    static func main() {
        // Runtime-link/load proof only: no HOME discovery, inventory, journal,
        // credentials, application launch, or destructive operation is reachable.
        if CommandLine.arguments.contains("--verify-runtime") {
            let alert=NSAlert();alert.messageText="Convo Caddy uninstaller runtime"
            let model=UninstallReviewModel()
            guard model.decision(paths:[]) == .keep else { exit(1) }
            print("uninstaller-runtime-ok")
            return
        }
        NSApplication.shared.setActivationPolicy(.accessory); NSApplication.shared.activate(ignoringOtherApps:true)
        let home=FileManager.default.homeDirectoryForCurrentUser
        let control=home.appendingPathComponent("Library/Application Support/Convo Caddy Control"),journal=FileOperationJournal(url:control.appendingPathComponent("operation.json"))
        let ui=NativeUninstallUI()
        UninstallFlow.run(ui:ui,home:home,inventory:{try ProductionInventory.build(home:home)},journal:journal,processes:RunningCaddyProcesses()) { request in
            let progress=RemovalProgress();progress.window.center();progress.window.makeKeyAndOrderFront(nil)
            defer {progress.window.orderOut(nil)}
            let coordinator=UninstallCoordinator(home:home,fs:DescriptorFileSystem(),lock:DarwinMaintenanceLock(lockURL:control.appendingPathComponent("lifecycle.lock")),processes:RunningCaddyProcesses(),journal:journal,keychain:KeychainCleaner(port:SecurityKeychainPort()),cancellation:progress,inventoryRefresher:ProductionInventoryRefresher(home:home),phaseBoundary:{ phase in MainActor.assumeIsolated { progress.reached(phase) } })
            return coordinator.run(request)
        }
    }
}

@MainActor final class NativeUninstallUI: UninstallDialogUI {
    func ask(_ dialog: UninstallDialog) -> Int {
        let alert=NSAlert();alert.messageText=dialog.title;alert.informativeText=dialog.detail
        for title in dialog.buttons {alert.addButton(withTitle:title)}
        for (index,button) in alert.buttons.enumerated() {
            button.keyEquivalent=index == dialog.defaultButton ? "\r" : (button.title == "Cancel" ? "\u{1b}" : "")
        }
        return alert.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
    }
    func show(_ dialog: UninstallDialog) {_ = ask(dialog)}
    func chooseWorkspacePreservation() -> URL? {
        let panel=NSOpenPanel();panel.canChooseDirectories=true;panel.canChooseFiles=false;panel.canCreateDirectories=true
        panel.prompt="Save Workspace Here"
        panel.message="This older workspace is inside app data. Choose a folder outside app data to keep it."
        return panel.runModal() == .OK ? panel.url : nil
    }
}
