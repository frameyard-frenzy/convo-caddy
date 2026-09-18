import Foundation
import Testing
@testable import UninstallCore

@MainActor @Suite("Uninstall production dialog flow")
struct DialogFlowTests {
    @Test("No workspace Uninstall needs one ordinary consent, even with a checkpoint")
    func noWorkspace() throws {
        for checkpoint in [nil, "{malformed", #"{"schemaVersion":1,"state":{"capture":{"mode":"live_ready"}},"mutations":[],"workspace":null}"#] as [String?] {
            let f = try DialogFixture()
            if let checkpoint { try f.file("Library/Application Support/Convo Caddy/active-session.json", checkpoint) }
            try f.file("Documents/outside", "keep")
            let ui = DialogUI(answers: [0])
            f.run(ui)
            #expect(ui.prompts.count == 1)
            #expect(ui.prompts.first?.title == "Uninstall Convo Caddy")
            #expect(ui.prompts.first?.buttons == ["Uninstall", "Cancel"])
            #expect(ui.prompts.first?.detail.contains("workspace") == false)
            #expect(ui.prompts.first?.defaultButton == 0)
            #expect(ui.pickers == 0)
            #expect(!f.exists("Library/Application Support/Convo Caddy"))
            #expect(f.exists("Documents/outside"))
            #expect(f.keys.removed == 1)
            #expect(f.requests.count == 1)
            #expect(f.requests.first?.confirmed == true)
            #expect(f.requests.first?.destructiveWorkspaceConfirmed == false)
        }
    }

    @Test("Real producer checkpoints inform without blocking or requiring private backups")
    func producerCheckpoints() throws {
        let fixtures=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/UninstallCheckpoints")
        for name in ["idle","joining","ended","failed"] {
            let f=try DialogFixture(),ui=DialogUI(answers:[0])
            try f.file("Library/Application Support/Convo Caddy/active-session.json",String(contentsOf:fixtures.appendingPathComponent(name+".json"),encoding:.utf8))
            f.run(ui)
            #expect(ui.prompts.count == 1);#expect(ui.pickers == 0);#expect(f.keys.removed == 1)
            #expect(!f.exists("Library/Application Support/Convo Caddy"))
            let details=ui.prompts.map(\.detail).joined()
            #expect(details.contains("Check the meeting in Teams") == (name == "joining" || name == "failed"))
            #expect(!details.contains("recording stopped"))
        }
    }

    @Test("Progress uses ordinary words, not journal phases")
    func progressCopy() {
        #expect(UninstallReviewModel.progressText(.confirmed) == "Removing Convo Caddy…")
        #expect(UninstallReviewModel.progressText(.preserving) == "Saving your workspace…")
        #expect(UninstallReviewModel.progressText(.verifying) == "Finishing uninstall…")
    }

    @Test("No workspace Cancel and unrecognized modal responses never mutate", arguments: [1, 2, -1, 3])
    func cancel(answer: Int) throws {
        let f = try DialogFixture(), ui = DialogUI(answers: [answer])
        f.run(ui)
        #expect(f.requests.isEmpty)
        #expect(f.exists("Library/Application Support/Convo Caddy"))
        #expect(f.keys.removed == 0)
        #expect(ui.pickers == 0)
    }

    @Test("Dedicated Yes confirms the exact whole child in the primary prompt")
    func dedicatedYes() throws {
        let f = try DialogFixture(), workspace = try f.workspace(dedicated: true)
        try f.file("Documents/outside", "keep")
        let ui = DialogUI(answers: [1]); f.run(ui)
        #expect(ui.prompts.count == 1)
        #expect(ui.prompts.first?.title == "Also delete your workspace?")
        #expect(ui.prompts.first?.detail.contains(workspace.path) == true)
        #expect(ui.prompts.first?.detail.contains("entire folder") == true)
        #expect(f.requests.first?.destructiveWorkspaceConfirmed == true)
        #expect(!FileManager.default.fileExists(atPath: workspace.path))
        #expect(f.exists("Documents/outside"))
        #expect(f.keys.removed == 1)
    }

    @Test("Existing workspace retains prominent question, default keep and exact choices", arguments: [0,1,2])
    func workspaceChoices(answer:Int) throws {
        let f=try DialogFixture(),workspace=try f.workspace(dedicated:true)
        let before=try treeDigest(workspace),ui=DialogUI(answers:[answer])
        f.run(ui)
        #expect(ui.prompts.first?.title == "Also delete your workspace?")
        #expect(ui.prompts.first?.buttons == ["No","Yes","Cancel"])
        #expect(ui.prompts.first?.defaultButton == 0)
        #expect(ui.prompts.first?.detail.contains(workspace.path) == true)
        if answer == 2 {
            #expect(f.requests.isEmpty);#expect(f.keys.removed == 0)
            #expect(try treeDigest(workspace) == before)
        } else {
            #expect(f.requests.count == 1)
            #expect(f.requests.first?.destructiveWorkspaceConfirmed == (answer == 1))
            if answer == 0 {#expect(try treeDigest(workspace) == before)}
            else {#expect(!FileManager.default.fileExists(atPath:workspace.path))}
        }
    }

    @Test("External No leaves every byte at the same path without a picker")
    func externalKeep() throws {
        let f = try DialogFixture(), workspace = try f.workspace(dedicated: false)
        let before = try treeDigest(workspace), ui = DialogUI(answers: [0])
        f.run(ui)
        #expect(try treeDigest(workspace) == before)
        #expect(ui.pickers == 0)
        #expect(ui.prompts.count == 1)
        #expect(f.keys.removed == 1)
    }

    @Test("Old external root Yes cannot adopt or delete it")
    func ambiguousYes() throws {
        let f = try DialogFixture(), workspace = try f.workspace(dedicated: false)
        let before = try treeDigest(workspace), ui = DialogUI(answers: [1])
        f.run(ui)
        #expect(try treeDigest(workspace) == before)
        #expect(f.requests.isEmpty)
        #expect(ui.pickers == 0)
        #expect(ui.messages.last?.detail.contains("No") == true)
    }

    @Test("Known nested case alias keep is the only workspace-preservation picker")
    func nestedKeep() throws {
        let f = try DialogFixture()
        try f.file("Library/Application Support/Convo Caddy/interviews/keep", "original")
        let alias=f.home.appendingPathComponent("Library/Application Support/convo caddy/interviews")
        try #require(FileManager.default.fileExists(atPath: alias.path))
        try f.preferences(alias)
        let ui=DialogUI(answers:[0]);ui.destination=f.home.appendingPathComponent("Documents")
        try FileManager.default.createDirectory(at:ui.destination!,withIntermediateDirectories:true)
        f.run(ui)
        #expect(ui.prompts.count == 1);#expect(ui.pickers == 1)
        #expect(f.exists("Documents/Convo Caddy Preserved Workspace/keep"))
        #expect(!f.exists("Library/Application Support/Convo Caddy"))
    }

    @Test("Running application blocks before consent and cleanup")
    func running() throws {
        let f = try DialogFixture(), ui=DialogUI(answers:[1]); f.processes.running=true
        f.run(ui)
        #expect(ui.prompts.isEmpty);#expect(f.requests.isEmpty);#expect(f.keys.removed == 0)
        #expect(f.exists("Library/Application Support/Convo Caddy"))
    }

    @Test("Actual partial uninstall retries without losing its saved workspace or asking for another backup")
    func partialRetry() throws {
        let f=try DialogFixture()
        try f.file("Library/Application Support/Convo Caddy/workspace/keep","original")
        let first=DialogUI(answers:[0]);first.destination=f.home.appendingPathComponent("Documents")
        try FileManager.default.createDirectory(at:first.destination!,withIntermediateDirectories:true)
        f.run(first,phaseBoundary:{if $0 == .verifying {throw DialogFault.interrupted}})
        #expect(f.journal.value != nil);#expect(f.keys.removed == 0)
        #expect(f.exists("Documents/Convo Caddy Preserved Workspace/keep"))
        let retry=DialogUI(answers:[0]);f.run(retry)
        #expect(retry.prompts.count == 1);#expect(retry.pickers == 0)
        #expect(f.journal.value == nil);#expect(f.keys.removed == 1)
        #expect(retry.messages.last?.detail.contains("Convo Caddy Preserved Workspace") == true)
    }

    @Test("Actual interrupted copy retains its plan on Cancel and verifies the original destination on retry")
    func interruptedCopy() throws {
        let f=try DialogFixture()
        try f.file("Library/Application Support/Convo Caddy/workspace/keep","original")
        let destination=f.home.appendingPathComponent("Documents")
        try FileManager.default.createDirectory(at:destination,withIntermediateDirectories:true)
        let first=DialogUI(answers:[0]);first.destination=destination
        f.run(first,phaseBoundary:{if $0 == .preserving {throw DialogFault.interrupted}})
        let original=try #require(f.journal.value)
        #expect(original.preservation.first?.receipt == nil)
        let cancel=DialogUI(answers:[2]);f.run(cancel)
        #expect(f.journal.value?.operationID == original.operationID)
        #expect(cancel.pickers == 0)
        let retry=DialogUI(answers:[0]);retry.destination=destination;f.run(retry)
        #expect(retry.prompts.count == 1);#expect(retry.pickers == 1)
        #expect(f.journal.value == nil);#expect(f.keys.removed == 1)
        #expect(f.exists("Documents/Convo Caddy Preserved Workspace/keep"))
    }

    @Test("Interrupted uninstall needs fresh primary consent and keeps its journal on Cancel")
    func interrupted() throws {
        for answer in [0,1,2] {
            let f=try DialogFixture(), ui=DialogUI(answers:[answer])
            let prior=OperationJournal(phase:.incomplete,targets:[],workspaceChoice:.deleteDedicated)
            f.journal.value=prior
            f.run(ui)
            #expect(ui.prompts.count == 1)
            #expect(ui.prompts.first?.detail.contains("interrupted") == true)
            if answer != 0 { #expect(f.journal.value?.operationID == prior.operationID);#expect(f.requests.isEmpty);#expect(f.keys.removed == 0) }
            else { #expect(f.requests.first?.interruptedOperationAcknowledged == true);#expect(f.keys.removed == 1) }
        }
    }
}

@MainActor private final class DialogUI: UninstallDialogUI {
    var answers:[Int],prompts:[UninstallDialog]=[],messages:[UninstallDialog]=[],pickers=0,destination:URL?
    init(answers:[Int]) { self.answers=answers }
    func ask(_ dialog:UninstallDialog)->Int { prompts.append(dialog);return answers.isEmpty ? 2 : answers.removeFirst() }
    func show(_ dialog:UninstallDialog) { messages.append(dialog) }
    func chooseWorkspacePreservation()->URL? { pickers += 1;return destination }
}
private final class DialogKeys:KeychainPort,@unchecked Sendable {
    var removed=0
    func references(service:String)throws->[CredentialReference] { #expect(service == caddyKeychainService);return removed==0 ? [.init(Data([1]))] : [] }
    func delete(reference:CredentialReference)throws { removed += 1 }
}
private final class DialogProcesses:ProcessPort,@unchecked Sendable {
    var running=false
    func currentAppProcesses()->[URL] { running ? [URL(fileURLWithPath:"/synthetic/Convo Caddy.app")] : [] }
    func legacyOrUnknownProcesses()->[URL] { [] }
}
private final class DialogJournal:JournalPort,@unchecked Sendable {
    var value:OperationJournal?
    func load()throws->OperationJournal? {value}
    func save(_ value:OperationJournal)throws {self.value=value}
    func remove()throws {value=nil}
}
private enum DialogFault:Error {case interrupted}
private struct DialogLock:MaintenanceLocking {func withExclusiveLock<T>(_ body:()throws->T)throws->T {try body()}}
private struct DialogRefresh:InventoryRefreshing {let home:URL;func freshInventory(confirmed:RemovalInventory)throws->RemovalInventory {try ProductionInventory.build(home:home,applicationCandidates:[])}}
@MainActor private final class DialogFixture {
    let root:URL,home:URL,keys=DialogKeys(),journal=DialogJournal(),processes=DialogProcesses()
    var requests:[UninstallRequest]=[]
    init()throws {
        root=FileManager.default.temporaryDirectory.appendingPathComponent("caddy-dialog-\(UUID())")
        home=root.appendingPathComponent("home")
        try FileManager.default.createDirectory(at:home,withIntermediateDirectories:true)
        try file("Library/Application Support/Convo Caddy/private", "remove")
    }
    deinit {try? FileManager.default.removeItem(at:root)}
    func exists(_ relative:String)->Bool {FileManager.default.fileExists(atPath:home.appendingPathComponent(relative).path)}
    func file(_ relative:String,_ text:String)throws {
        let file=home.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true)
        try text.write(to:file,atomically:true,encoding:.utf8)
    }
    func preferences(_ workspace:URL)throws {
        let data=try JSONSerialization.data(withJSONObject:["schemaVersion":2,"workspaceRoot":workspace.path])
        try file("Library/Application Support/Convo Caddy/config/preferences.json",String(decoding:data,as:UTF8.self))
    }
    func workspace(dedicated:Bool)throws->URL {
        try file("Documents/Convo Caddy Workspace/keep","original")
        let workspace=home.appendingPathComponent("Documents/Convo Caddy Workspace")
        if dedicated {
            let id=try DescriptorFileSystem().identity(workspace)
            let data=try JSONSerialization.data(withJSONObject:["schemaVersion":1,"application":caddyBundleIdentifier,"device":String(id.device),"inode":String(id.inode)])
            try data.write(to:workspace.appendingPathComponent(".convo-caddy-workspace.json"))
        }
        try preferences(workspace);return workspace
    }
    func run(_ ui:DialogUI,phaseBoundary:@escaping @Sendable(OperationPhase)throws->Void={_ in}) {
        UninstallFlow.run(ui:ui,home:home,inventory:{try ProductionInventory.build(home:self.home,applicationCandidates:[])},journal:journal,processes:processes) { request in
            self.requests.append(request)
            return UninstallCoordinator(home:self.home,fs:DescriptorFileSystem(),lock:DialogLock(),processes:self.processes,journal:self.journal,keychain:KeychainCleaner(port:self.keys),inventoryRefresher:DialogRefresh(home:self.home),phaseBoundary:phaseBoundary).run(request)
        }
    }
}
