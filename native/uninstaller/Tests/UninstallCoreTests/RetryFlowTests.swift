import Foundation
import Testing
@testable import UninstallCore

@MainActor @Suite("Persisted uninstall retry flow")
struct RetryFlowTests {
    @Test("Lost preferences retry shows exact journal workspace for fresh No Yes Cancel", arguments:[0,1,2])
    func freshConsent(answer:Int)throws {
        let f=try RetryFixture();try f.interruptAfterSupport()
        let prior=try Data(contentsOf:f.journalURL),before=try treeDigest(f.workspace)
        let ui=RetryUI(answer);f.run(ui)
        #expect(ui.prompts.count == 1)
        #expect(ui.prompts.first?.detail.contains(f.workspace.path) == true)
        #expect(ui.prompts.first?.detail.contains("entire folder") == true)
        #expect(ui.prompts.first?.buttons == ["No","Yes","Cancel"])
        #expect(ui.prompts.first?.title == "Also delete your workspace?")
        #expect(ui.prompts.first?.defaultButton == 0)
        #expect(ui.pickers == 0);#expect(f.exists(f.outside))
        if answer == 2 {
            #expect(try Data(contentsOf:f.journalURL) == prior)
            #expect(try treeDigest(f.workspace) == before);#expect(f.keys.removed == 0)
        } else {
            #expect(!f.exists(f.journalURL));#expect(f.keys.removed == 1)
            if answer == 0 {
                #expect(try treeDigest(f.workspace) == before)
                #expect(ui.messages.last?.detail.contains(f.workspace.path) == true)
            } else {#expect(!f.exists(f.workspace))}
        }
    }

    @Test("Retry never forgets a kept workspace if fresh No is interrupted again")
    func interruptedKeep()throws {
        let f=try RetryFixture();try f.interruptAfterSupport()
        f.run(RetryUI(0),boundary:{if $0 == .confirmed {throw RetryFault.interrupt}})
        #expect(f.exists(f.journalURL));#expect(f.exists(f.workspace))
        let ui=RetryUI(0);f.run(ui)
        #expect(ui.prompts.first?.detail.contains(f.workspace.path) == true)
        #expect(ui.messages.last?.detail.contains(f.workspace.path) == true)
        #expect(f.exists(f.workspace));#expect(!f.exists(f.journalURL))
    }

    @Test("Replaced or unverified retry target stays blocked with persisted evidence", arguments:["replacement","marker","broad","symlink"])
    func changedTarget(change:String)throws {
        let f=try RetryFixture();try f.interruptAfterSupport()
        if change == "replacement" {
            try FileManager.default.moveItem(at:f.workspace,to:f.home.appendingPathComponent("original"))
            try f.file(f.workspace.appendingPathComponent("unrelated"),"keep")
            try f.marker(f.workspace)
        } else if change == "marker" {
            try FileManager.default.removeItem(at:f.workspace.appendingPathComponent(".convo-caddy-workspace.json"))
        } else if change == "symlink" {
            try FileManager.default.moveItem(at:f.workspace,to:f.home.appendingPathComponent("original"))
            try FileManager.default.createSymbolicLink(at:f.workspace,withDestinationURL:f.home.appendingPathComponent("original"))
        } else {
            var journal=try #require(try FileOperationJournal(url:f.journalURL).load())
            journal.targets.append(.init(path:f.home.appendingPathComponent("Work").path,identity:try DescriptorFileSystem().identity(f.home.appendingPathComponent("Work"))))
            try FileOperationJournal(url:f.journalURL).save(journal)
        }
        let prior=try Data(contentsOf:f.journalURL),ui=RetryUI(1)
        f.run(ui)
        #expect(f.exists(f.journalURL))
        if f.exists(f.journalURL) {#expect(try Data(contentsOf:f.journalURL) == prior)}
        #expect(f.exists(f.workspace));#expect(f.exists(f.outside));#expect(f.keys.removed == 0)
        #expect(ui.messages.last?.title != "Convo Caddy uninstalled")
        #expect(ui.messages.last?.detail.contains("Work") == true)
    }

    @Test("Retry revalidates journal workspace identity after primary consent")
    func changedAfterConsent()throws {
        let f=try RetryFixture();try f.interruptAfterSupport()
        let prior=try Data(contentsOf:f.journalURL),ui=RetryUI(1)
        ui.onAsk={
            try! FileManager.default.moveItem(at:f.workspace,to:f.home.appendingPathComponent("original"))
            try! f.file(f.workspace.appendingPathComponent("unrelated"),"keep")
            try! f.marker(f.workspace)
        }
        f.run(ui)
        #expect(ui.prompts.count == 1);#expect(f.exists(f.workspace));#expect(f.keys.removed == 0)
        #expect(f.exists(f.journalURL))
        if f.exists(f.journalURL){#expect(try Data(contentsOf:f.journalURL) == prior)}
        #expect(ui.messages.last?.title != "Convo Caddy uninstalled")
    }

    @Test("Retry binds ownership marker identity across primary consent")
    func markerChangedAfterConsent()throws {
        let f=try RetryFixture();try f.interruptAfterSupport()
        let prior=try Data(contentsOf:f.journalURL),ui=RetryUI(1)
        let marker=f.workspace.appendingPathComponent(".convo-caddy-workspace.json")
        let identity=try DescriptorFileSystem().identity(marker)
        ui.onAsk={
            try! FileManager.default.moveItem(at:marker,to:f.home.appendingPathComponent("old-marker"))
            try! f.marker(f.workspace)
        }
        f.run(ui)
        #expect(f.exists(f.workspace));#expect(f.keys.removed == 0);#expect(f.exists(f.journalURL))
        if f.exists(marker){#expect(try DescriptorFileSystem().identity(marker) != identity)}
        if f.exists(f.journalURL){#expect(try Data(contentsOf:f.journalURL) == prior)}
        #expect(ui.messages.last?.title != "Convo Caddy uninstalled")
    }

    @Test("Already removed journal workspace gets ordinary Uninstall or Cancel", arguments:[0,1])
    func alreadyMissing(answer:Int)throws {
        let f=try RetryFixture();try f.interruptAfterSupport()
        try FileManager.default.removeItem(at:f.workspace)
        let prior=try Data(contentsOf:f.journalURL),ui=RetryUI(answer);f.run(ui)
        #expect(ui.prompts.count == 1);#expect(ui.pickers == 0)
        #expect(ui.prompts.first?.title == "Uninstall Convo Caddy")
        #expect(ui.prompts.first?.buttons == ["Uninstall","Cancel"])
        #expect(f.exists(f.outside))
        if answer == 0 {
            #expect(!f.exists(f.journalURL));#expect(f.keys.removed == 1)
            #expect(ui.messages.last?.title == "Convo Caddy uninstalled")
            #expect(ui.messages.last?.detail.contains("Workspace kept") == false)
        } else {
            #expect(try Data(contentsOf:f.journalURL) == prior)
            #expect(f.keys.removed == 0);#expect(ui.messages.isEmpty)
        }
    }
}

private enum RetryFault:Error {case interrupt}
@MainActor private final class RetryUI:UninstallDialogUI {
    var onAsk:(()->Void)?
    let answer:Int;var prompts:[UninstallDialog]=[],messages:[UninstallDialog]=[],pickers=0
    init(_ answer:Int){self.answer=answer}
    func ask(_ dialog:UninstallDialog)->Int{prompts.append(dialog);onAsk?();return answer}
    func show(_ dialog:UninstallDialog){messages.append(dialog)}
    func chooseWorkspacePreservation()->URL?{pickers += 1;return nil}
}
private final class RetryKeys:KeychainPort,@unchecked Sendable {
    var removed=0
    func references(service:String)throws->[CredentialReference]{#expect(service == caddyKeychainService);return removed == 0 ? [.init(Data([1]))] : []}
    func delete(reference:CredentialReference)throws{removed += 1}
}
private struct RetryRefresh:InventoryRefreshing {
    let home:URL
    func freshInventory(confirmed:RemovalInventory)throws->RemovalInventory{try ProductionInventory.build(home:home,applicationCandidates:[])}
}
@MainActor private final class RetryFixture {
    let home:URL,support:URL,workspace:URL,outside:URL,journalURL:URL,keys=RetryKeys()
    init()throws {
        let temporary=FileManager.default.temporaryDirectory.path
        let path=temporary.hasPrefix("/private/var/") ? String(temporary.dropFirst(8)) : temporary
        home=URL(fileURLWithPath:path).appendingPathComponent("retry-\(UUID())")
        support=home.appendingPathComponent("Library/Application Support/Convo Caddy")
        workspace=home.appendingPathComponent("Work/Convo Caddy Workspace")
        outside=home.appendingPathComponent("Work/outside")
        journalURL=home.appendingPathComponent("Library/Application Support/Convo Caddy Control/operation.json")
        try file(workspace.appendingPathComponent("prep"),"synthetic original")
        try file(outside,"unrelated sentinel");try marker(workspace)
        let prefs=try JSONSerialization.data(withJSONObject:["schemaVersion":2,"workspaceRoot":workspace.path])
        try file(support.appendingPathComponent("config/preferences.json"),String(decoding:prefs,as:UTF8.self))
    }
    deinit{try? FileManager.default.removeItem(at:home)}
    func exists(_ url:URL)->Bool{DescriptorFileSystem().exists(url)}
    func file(_ url:URL,_ text:String)throws{try FileManager.default.createDirectory(at:url.deletingLastPathComponent(),withIntermediateDirectories:true);try text.write(to:url,atomically:true,encoding:.utf8)}
    func marker(_ url:URL)throws {
        let id=try DescriptorFileSystem().identity(url)
        let data=try JSONSerialization.data(withJSONObject:["schemaVersion":1,"application":caddyBundleIdentifier,"device":String(id.device),"inode":String(id.inode)])
        try data.write(to:url.appendingPathComponent(".convo-caddy-workspace.json"))
    }
    func interruptAfterSupport()throws {
        let support=self.support
        run(RetryUI(1),boundary:{if $0 == .deleting && !DescriptorFileSystem().exists(support){throw RetryFault.interrupt}})
        #expect(!exists(support));#expect(exists(workspace));#expect(keys.removed == 0)
        let prior=try #require(try FileOperationJournal(url:journalURL).load())
        #expect(prior.targets.contains{$0.path == workspace.standardizedFileURL.path && !$0.complete})
        #expect(prior.targets.contains{$0.path == support.standardizedFileURL.path && $0.complete})
        #expect(try ProductionInventory.build(home:home,applicationCandidates:[]).workspaces.isEmpty)
        // Reproduce the actual reviewed schema-v2 journal, without new metadata.
        var object=try JSONSerialization.jsonObject(with:Data(contentsOf:journalURL)) as! [String:Any]
        object.removeValue(forKey:"reviewedWorkspaces")
        try JSONSerialization.data(withJSONObject:object).write(to:journalURL)
    }
    func run(_ ui:RetryUI,boundary:@escaping @Sendable(OperationPhase)throws->Void={_ in}) {
        // New journal instance on every invocation: the retry must survive process loss.
        let journal=FileOperationJournal(url:journalURL)
        UninstallFlow.run(ui:ui,home:home,inventory:{try ProductionInventory.build(home:self.home,applicationCandidates:[])},journal:journal,processes:EmptyProcessPort()) { request in
            UninstallCoordinator(home:self.home,fs:DescriptorFileSystem(),lock:DarwinMaintenanceLock(lockURL:self.journalURL.deletingLastPathComponent().appendingPathComponent("lifecycle.lock")),processes:EmptyProcessPort(),journal:journal,keychain:KeychainCleaner(port:self.keys),inventoryRefresher:RetryRefresh(home:self.home),phaseBoundary:boundary).run(request)
        }
    }
}
