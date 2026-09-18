import Darwin
import Foundation
import Testing
@testable import UninstallCore

@Suite("U1 semantic safety matrix")
struct UninstallMatrixTests {
    @Test("W1 external workspace + default No removes private state and preserves every byte")
    func w1() throws {
        let h = try Harness()
        let workspace = try h.directory("external", files: ["prep/.hidden": "kept", "finished-conversations/a": "kept"])
        let before = try treeDigest(workspace)
        let outcome = h.run(workspaces: [try h.target(workspace, .external)])
        #expect(outcome == .complete(retained: [workspace], removedCredentials: 0))
        #expect(try treeDigest(workspace) == before)
        #expect(!h.fs.exists(h.privateRoot))
    }

    @Test("W2 legacy nested + No publishes verified no-overwrite preservation before deleting ancestor")
    func w2() throws {
        let h = try Harness()
        let legacy = try h.directory("home/Library/Application Support/Convo Caddy/workspace", files: [".unknown": "x", "prep/a": "y"])
        let destination = try h.directory("preserve", files: [:])
        let outcome = h.run(workspaces: [try h.target(legacy, .legacyNested)], preservation: destination)
        let published = destination.appendingPathComponent("Convo Caddy Preserved Workspace")
        #expect(outcome.complete)
        #expect(h.fs.exists(published.appendingPathComponent(".unknown")))
        #expect(!h.fs.exists(h.privateRoot))
        let h2 = try Harness(), legacy2 = try h2.directory("home/Library/Application Support/Convo Caddy/workspace", files: ["a": "source"]), dest2 = try h2.directory("preserve/Convo Caddy Preserved Workspace", files: ["a": "existing"])
        #expect(h2.run(workspaces: [try h2.target(legacy2, .legacyNested)], preservation: dest2.deletingLastPathComponent()).incomplete)
        #expect(h2.fs.exists(legacy2))
    }

    @Test("W3 dedicated Yes requires final affirmative consent and removes exact workspace")
    func w3() throws {
        let h = try Harness(), workspace = try h.directory("dedicated", files: ["prep/a": "x"]), target = try h.target(workspace, .dedicated)
        #expect(h.run(workspaces: [target], choice: .deleteDedicated).blocked)
        #expect(h.fs.exists(workspace))
        #expect(h.run(workspaces: [target], choice: .deleteDedicated, destructive: true).complete)
        #expect(!h.fs.exists(workspace))
    }

    @Test("W5 unreadable preferences symlink ancestor root home wrong owner and inode change block")
    func w5() throws {
        let h = try Harness()
        #expect(h.run(inventory: .init(privateRoots: [h.privateRoot], applicationBundles: [], workspaces: [], preferencesReadable: false)).blocked)
        #expect(throws: InventoryError.self) { try PathGuard(home: h.home).requireSafeDeletionRoot(h.home) }
        let link = h.root.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: h.privateRoot)
        #expect(throws: InventoryError.self) { try PathGuard(home: h.home).requireSafeWorkspace(link) }
        #expect(throws: FileSystemError.identityChanged) { try h.fs.removeTree(h.privateRoot, expected: .init(device: 1, inode: 1)) }
    }

    @Test("U3 W5 root home true symlink ancestor and wrong bundle are rejected")
    func u3W5ExpandedPathAndBundleProof() throws {
        let h = try Harness()
        #expect(throws: InventoryError.self) { try PathGuard(home: h.home).requireSafeDeletionRoot(URL(fileURLWithPath: "/")) }
        #expect(throws: InventoryError.self) { try PathGuard(home: h.home).requireSafeDeletionRoot(h.home) }
        let realParent = try h.directory("real-parent/workspace", files: ["sentinel": "keep"])
        let aliasParent = h.root.appendingPathComponent("alias-parent")
        try FileManager.default.createSymbolicLink(at: aliasParent, withDestinationURL: realParent.deletingLastPathComponent())
        #expect(throws: InventoryError.self) { try PathGuard(home: h.home).requireSafeWorkspace(aliasParent.appendingPathComponent("workspace")) }

        let wrongApp = try h.directory("Applications/Convo Caddy.app/Contents", files: ["Info.plist": #"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>example.not-caddy</string><key>CFBundleExecutable</key><string>Fake</string></dict></plist>"#])
        #expect(throws: InventoryError.self) {
            _ = try ProductionInventory.build(home: h.home, applicationCandidates: [wrongApp.deletingLastPathComponent()])
        }
    }

    @Test("U3 W5 owner permission and mount device replacement block deletion")
    func u3W5OwnerAndMountFaults() throws {
        for fault in [FileSystemError.permissionDenied, .mountChanged] {
            let fs = IdentityFaultFileSystem(fault: fault)
            let h = try Harness(fs: fs)
            let outcome = h.run()
            #expect(outcome.incomplete)
            #expect(h.fs.exists(h.privateRoot))
            #expect(fs.removalAttempts == 1)
        }
    }

    @Test(arguments: [PreservationBoundary.beforeCopy, .afterCopy, .beforeSync, .afterSync, .beforePublish, .afterPublish])
    func w6FailureBoundariesKeepOriginal(boundary: PreservationBoundary) throws {
        let h = try Harness(), source = try h.directory("source", files: ["a": "original"]), destination = h.root.appendingPathComponent("saved")
        let preserver = WorkspacePreserver { point in if point == boundary { throw TestError.injected } }
        #expect(throws: (any Error).self) { try preserver.preserve(source: h.target(source, .legacyNested), destination: destination) }
        #expect(h.fs.exists(source.appendingPathComponent("a")))
    }

    @Test("W6 existing destination and changed source identity retain original")
    func w6CollisionAndChange() throws {
        let h = try Harness(), source = try h.directory("source", files: ["a": "original"]), destination = try h.directory("saved", files: ["sentinel": "existing"])
        #expect(throws: PreservationError.destinationExists) { try WorkspacePreserver().preserve(source: h.target(source, .legacyNested), destination: destination) }
        let wrong = WorkspaceTarget(url: source, kind: .legacyNested, identity: .init(device: 9, inode: 9))
        #expect(throws: PreservationError.sourceChanged) { try WorkspacePreserver().preserve(source: wrong, destination: h.root.appendingPathComponent("other")) }
        #expect(h.fs.exists(source.appendingPathComponent("a")))
    }

    @Test("U3 W6 full disk at production write seam preserves original and containing root")
    func u3W6FullDisk() throws {
        let h=try Harness(),source=try h.directory("full-disk/source",files:["evidence":"original-full-disk"]),parent=source.deletingLastPathComponent()
        try "ordinary-sentinel".write(to:parent.appendingPathComponent("ordinary.keep"),atomically:true,encoding:.utf8);try "hidden-sentinel".write(to:parent.appendingPathComponent(".hidden-keep"),atomically:true,encoding:.utf8)
        let evidence=source.appendingPathComponent("evidence"),bytes=try Data(contentsOf:evidence),identity=try h.fs.identity(evidence),metadata=try FileManager.default.attributesOfItem(atPath:evidence.path),digest=try treeDigest(parent)
        let preserver=WorkspacePreserver(ioFailure:{ operation in if case .dataWrite = operation{return ENOSPC};return nil })
        #expect(throws:PreservationError.durabilityFailed){try preserver.preserve(source:h.target(source,.legacyNested),destination:h.root.appendingPathComponent("full-disk-destination"))}
        try assertW6Original(parent:parent,evidence:evidence,bytes:bytes,identity:identity,metadata:metadata,digest:digest,fs:h.fs)
    }

    @Test("U3 W6 cross volume interrupted second copy chunk preserves original and containing root")
    func u3W6CrossVolumeInterruptedCopy() throws {
        let h=try Harness(),source=try h.directory("cross-volume/source",files:["evidence":String(repeating:"x",count:131072)]),parent=source.deletingLastPathComponent()
        try "ordinary-sentinel".write(to:parent.appendingPathComponent("ordinary.keep"),atomically:true,encoding:.utf8);try "hidden-sentinel".write(to:parent.appendingPathComponent(".hidden-keep"),atomically:true,encoding:.utf8)
        let evidence=source.appendingPathComponent("evidence"),bytes=try Data(contentsOf:evidence),identity=try h.fs.identity(evidence),metadata=try FileManager.default.attributesOfItem(atPath:evidence.path),digest=try treeDigest(parent)
        let preserver=WorkspacePreserver(ioFailure:{ operation in if case let .dataWrite(_,offset)=operation,offset>=65536{return EXDEV};return nil })
        #expect(throws:PreservationError.interrupted){try preserver.preserve(source:h.target(source,.legacyNested),destination:h.root.appendingPathComponent("other-volume/preserved"))}
        #expect(bytes.count == 131072);try assertW6Original(parent:parent,evidence:evidence,bytes:bytes,identity:identity,metadata:metadata,digest:digest,fs:h.fs)
    }

    @Test("U3 W6 unavailable destination volume open preserves original and containing root")
    func u3W6UnavailableVolume() throws {
        let h=try Harness(),source=try h.directory("unavailable/source",files:["evidence":"original-unavailable"]),parent=source.deletingLastPathComponent()
        try "ordinary-sentinel".write(to:parent.appendingPathComponent("ordinary.keep"),atomically:true,encoding:.utf8);try "hidden-sentinel".write(to:parent.appendingPathComponent(".hidden-keep"),atomically:true,encoding:.utf8)
        let evidence=source.appendingPathComponent("evidence"),bytes=try Data(contentsOf:evidence),identity=try h.fs.identity(evidence),metadata=try FileManager.default.attributesOfItem(atPath:evidence.path),digest=try treeDigest(parent)
        let preserver=WorkspacePreserver(ioFailure:{ operation in operation == .destinationVolumeOpen ? ENODEV:nil })
        #expect(throws:PreservationError.interrupted){try preserver.preserve(source:h.target(source,.legacyNested),destination:h.root.appendingPathComponent("ejected-volume/preserved"))}
        try assertW6Original(parent:parent,evidence:evidence,bytes:bytes,identity:identity,metadata:metadata,digest:digest,fs:h.fs)
    }

    @Test("K1 exact service generations across custom keychains delete persistent refs without secret reads")
    func k1() {
        let port = FakeKeychain(rows: [.init(Data([1]), keychainPath: "custom"), .init(Data([2]), keychainPath: "login")])
        #expect(KeychainCleaner(port: port).clean() == .complete(removed: 2))
        #expect(port.requested == [caddyKeychainService, caddyKeychainService]); #expect(port.deleted.count == 2); #expect(port.secretReads == 0)
    }

    @Test("review36 keychain surviving references cannot report complete")
    func review36KeychainAbsence() {
        let port = FakeKeychain(rows: [.init(Data([7]))], retainAfterDelete: true)
        #expect(KeychainCleaner(port: port).clean().incomplete)
        #expect(port.requested == [caddyKeychainService, caddyKeychainService])
    }

    @Test("K2 locked denied unavailable Keychain is incomplete and retry is explicit")
    func k2() {
        let denied = FakeKeychain(rows: [], failure: TestError.denied)
        #expect(KeychainCleaner(port: denied).clean().incomplete)
        let retry = FakeKeychain(rows: [.init(Data([3]))])
        #expect(KeychainCleaner(port: retry).clean() == .complete(removed: 1))
    }

    @Test("L1 private checkpoint cleanup needs no backup or remote action")
    func l1() throws {
        let h=try Harness()
        try "checkpoint".write(to:h.privateRoot.appendingPathComponent("active-session.json"),atomically:true,encoding:.utf8)
        let inventory=try ProductionInventory.build(home:h.home,applicationCandidates:[])
        #expect(h.run(inventory:inventory).complete)
        #expect(!h.fs.exists(h.privateRoot))
        #expect(h.processes.remoteMutations == 0)
    }

    @Test("L2 exclusive lock uses stable inode, serializes uninstallers, and releases after owner exits")
    func l2() throws {
        let h = try Harness(), url = h.root.appendingPathComponent("control/lifecycle.lock"), lock = DarwinMaintenanceLock(lockURL: url)
        _ = try lock.withExclusiveLock { #expect(throws: (any Error).self) { try lock.withExclusiveLock {} } }
        let first = try h.fs.identity(url)
        try lock.withExclusiveLock {}
        #expect(try h.fs.identity(url) == first)
    }

    @Test("L3 legacy or unknown process blocks without name kill, provider mutation, or unrelated-service change")
    func l3() throws {
        let processes = FakeProcesses(legacy: [URL(fileURLWithPath: "/old/Convo Caddy")]), h = try Harness(processes: processes)
        #expect(h.run().blocked); #expect(processes.kills == 0); #expect(processes.remoteMutations == 0); #expect(h.fs.exists(h.privateRoot))
    }

    @Test(arguments: [OperationPhase.confirmed, .exclusive, .preserving, .preserved, .deleting, .verifying])
    func r1CrashAtJournalAndDeletionBoundariesIsIncompleteAndNeedsFreshConfirmation(phase: OperationPhase) throws {
        let h = try Harness()
        let needsPreservation=phase == .preserving || phase == .preserved
        let workspace=needsPreservation ? try h.directory("home/Library/Application Support/Convo Caddy/workspace",files:["a":"evidence"]):nil
        let destination=needsPreservation ? try h.directory("r1-preserve",files:[:]):nil
        let workspaces=try workspace.map{[try h.target($0,.legacyNested)]} ?? []
        let outcome = h.run(workspaces:workspaces,preservation:destination,phaseBoundary: { point in if point == phase { throw TestError.injected } })
        #expect(outcome.incomplete)
        #expect(h.run(confirmed: false).blocked)
    }

    @Test("R2 cancel before mutation preserves data; repeated run is idempotent; concurrent lock is excluded")
    func r2() throws {
        let h = try Harness(); #expect(h.run(confirmed: false).blocked); #expect(h.fs.exists(h.privateRoot))
        #expect(h.run(cancellation: FixedCancellation(true)).incomplete); #expect(h.fs.exists(h.privateRoot))
        let h2 = try Harness(), first = h2.privateRoot.appendingPathComponent("state"), second = try h2.directory("home/Library/Logs/Convo Caddy", files:["log":"x"])
        let cancellation = BoundaryCancellation(cancelAfterChecks: 1)
        #expect(h2.run(inventory:.init(privateRoots:[first,second],applicationBundles:[],workspaces:[]),cancellation:cancellation).incomplete)
        #expect(!h2.fs.exists(first)); #expect(h2.fs.exists(second))
        #expect(h.run().complete); #expect(h.run().complete)
    }

    @Test("review36 each deletion target offers cancellation event delivery")
    func review36CancellationEventDelivery() throws {
        let h = try Harness(), cancel = ManualCancellation()
        let second = try h.directory("home/Library/Logs/Convo Caddy", files: ["log": "retain"])
        let first = h.privateRoot.appendingPathComponent("state")
        let outcome = h.run(inventory: .init(privateRoots: [first, second], applicationBundles: [], workspaces: []), cancellation: cancel, phaseBoundary: { [fs = h.fs] phase in
            if phase == .deleting && !fs.exists(first) { cancel.cancelled = true }
        })
        #expect(outcome.incomplete)
        #expect(h.fs.exists(second))
    }

    @Test(arguments: [OperationPhase.deleting, .verifying])
    func review36CancellationBeforeCredentials(phase: OperationPhase) throws {
        let h = try Harness(), cancel = ManualCancellation()
        let outcome = h.run(inventory: .init(privateRoots: [], applicationBundles: [], workspaces: []), cancellation: cancel, phaseBoundary: { if $0 == phase { cancel.cancelled = true } })
        #expect(outcome.incomplete)
    }

    @Test("P1 missing app, ejected DMG, and absent optional paths are normal")
    func p1() throws { #expect(try Harness().run().complete) }

    @Test("P2 nonwritable target returns incomplete without root escalation")
    func p2() throws { let fs = FailingFileSystem(), h = try Harness(fs: fs); #expect(h.run().incomplete); #expect(fs.escalations == 0) }

    @Test("review W1 selected current workspace nested under private state survives default No")
    func reviewNestedCurrentWorkspaceKeep() throws {
        let h = try Harness()
        let workspace = try h.directory("home/Library/Application Support/Convo Caddy/user-selected", files: [".sentinel": "must survive"])
        let outcome = h.run(workspaces: [try h.target(workspace, .external)])
        #expect(!outcome.complete || h.fs.exists(workspace.appendingPathComponent(".sentinel")))
    }

    @Test("review W5 valid JSON with invalid preference schema is not readable ownership evidence")
    func reviewMalformedPreferences() throws {
        let h = try Harness()
        _ = try h.directory("home/Library/Application Support/Convo Caddy/config", files: ["preferences.json": #"{"schemaVersion":2,"workspaceRoot":42}"#])
        let inventory = try ProductionInventory.build(home: h.home)
        #expect(!inventory.preferencesReadable)
    }

    @Test("review L1 legacy pointer does not prove a remote capture; known workspace stays protected")
    func reviewLegacyRecoveryDiscovery() throws {
        let h = try Harness()
        _ = try h.directory("home/Library/Application Support/Convo Caddy/workspace", files: ["current-session.json": #"{"schemaVersion":1,"sessionId":"synthetic-session"}"#, "sessions/synthetic-session/session.json": #"{"status":"active"}"#])
        let inventory = try ProductionInventory.build(home: h.home)
        #expect(!inventory.possiblyUnfinishedCapture)
        #expect(inventory.workspaces.contains(where:{$0.kind == .legacyNested}))
    }

    @Test("review W6 changed source after preservation cannot be deleted as verified")
    func reviewSourceChangedAfterPreservation() throws {
        let h = try Harness()
        let workspace = try h.directory("home/Library/Application Support/Convo Caddy/workspace", files: ["a": "old"])
        let destination = try h.directory("preserve", files: [:])
        let changed = workspace.appendingPathComponent("a")
        let outcome = h.run(workspaces: [try h.target(workspace, .legacyNested)], preservation: destination, phaseBoundary: { phase in
            if phase == .preserved { try "new unsaved evidence".write(to: changed, atomically: true, encoding: .utf8) }
        })
        #expect(!outcome.complete)
        #expect(h.fs.exists(changed))
    }

    @Test("review W6 preservation destination alias inside deletion root cannot authorize deletion")
    func reviewPreservationDestinationAlias() throws {
        let h = try Harness()
        let workspace = try h.directory("home/Library/Application Support/Convo Caddy/workspace", files: ["a": "irreplaceable"])
        let inside = try h.directory("home/Library/Application Support/Convo Caddy/backup", files: [:])
        let alias = h.root.appendingPathComponent("apparently-external")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: inside)
        let outcome = h.run(workspaces: [try h.target(workspace, .legacyNested)], preservation: alias)
        #expect(!outcome.complete)
        #expect(h.fs.exists(workspace.appendingPathComponent("a")))
    }

    @Test("review final verification must verify preserved data after source deletion")
    func reviewFinalPreservationVerification() throws {
        let h = try Harness()
        let workspace = try h.directory("home/Library/Application Support/Convo Caddy/workspace", files: ["a": "original"])
        let destination = try h.directory("preserve", files: [:])
        let publishedFile = destination.appendingPathComponent("Convo Caddy Preserved Workspace/a")
        let outcome = h.run(workspaces: [try h.target(workspace, .legacyNested)], preservation: destination, phaseBoundary: { phase in
            if phase == .verifying { try "corrupted".write(to: publishedFile, atomically: true, encoding: .utf8) }
        })
        #expect(!outcome.complete)
    }

    @Test("review preservation inventory distinguishes regular files from symlinks")
    func reviewDigestEntryTypes() throws {
        let h = try Harness()
        let regular = try h.directory("regular", files: ["a": "target"])
        let symbolic = try h.directory("symbolic", files: [:])
        try FileManager.default.createSymbolicLink(atPath: symbolic.appendingPathComponent("a").path, withDestinationPath: "target")
        #expect(try treeDigest(regular) != treeDigest(symbolic))
    }

    @Test("review confirmed dedicated workspace identity cannot authorize its replacement")
    func reviewConfirmedWorkspaceReplacement() throws {
        let h = try Harness()
        let workspace = try h.directory("dedicated", files: ["a": "approved"])
        let approved = try h.target(workspace, .dedicated)
        try FileManager.default.moveItem(at: workspace, to: h.root.appendingPathComponent("original"))
        _ = try h.directory("dedicated", files: ["unrelated": "not approved"])
        let outcome = h.run(workspaces: [approved], choice: .deleteDedicated, destructive: true)
        #expect(!outcome.complete)
        #expect(h.fs.exists(workspace.appendingPathComponent("unrelated")))
    }

    @Test("recovery descriptor-pinned root replacement never deletes the replacement")
    func recoveryRootReplacementRace() throws {
        let h=try Harness(),target=try h.directory("race",files:["approved":"old"]),original=h.root.appendingPathComponent("race-original")
        let identity=try h.fs.identity(target),racing=DescriptorFileSystem{ boundary in if case .rootOpened=boundary { try FileManager.default.moveItem(at:target,to:original);try FileManager.default.createDirectory(at:target,withIntermediateDirectories:false);try "keep".write(to:target.appendingPathComponent("replacement"),atomically:true,encoding:.utf8) } }
        #expect(throws:FileSystemError.identityChanged){try racing.removeTree(target,expected:identity)}
        #expect(h.fs.exists(target.appendingPathComponent("replacement")))
    }

    @Test("recovery descriptor-pinned entry replacement never unlinks the replacement")
    func recoveryEntryReplacementRace() throws {
        let h=try Harness(),target=try h.directory("entry-race",files:["a":"approved"]),identity=try h.fs.identity(target)
        let racing=DescriptorFileSystem{ boundary in if case .beforeEntryUnlink("a")=boundary { try FileManager.default.moveItem(at:target.appendingPathComponent("a"),to:target.appendingPathComponent("old"));try "replacement".write(to:target.appendingPathComponent("a"),atomically:true,encoding:.utf8) } }
        #expect(throws:FileSystemError.identityChanged){try racing.removeTree(target,expected:identity)}
        #expect(try String(contentsOf:target.appendingPathComponent("a"),encoding:.utf8)=="replacement")
    }

    @Test("recovery failed durability retains source and journal-pinned staging evidence")
    func recoveryFailedSync() throws {
        let h=try Harness(),source=try h.directory("sync-source",files:["a":"evidence"]),destination=h.root.appendingPathComponent("saved"),operation=UUID()
        let preserver=WorkspacePreserver{if case .beforeSync=$0{throw TestError.injected}},plan=try preserver.prepare(source:h.target(source,.legacyNested),destination:destination,operationID:operation)
        #expect(throws:(any Error).self){try preserver.execute(plan)}
        #expect(h.fs.exists(source.appendingPathComponent("a")));#expect(h.fs.exists(destination.deletingLastPathComponent().appendingPathComponent(plan.stagingName)))
    }

    @Test("recovery writes preservation plan before staging and requires acknowledgment on restart")
    func recoveryWriteAheadAndRestart() throws {
        let journal=MemoryJournal(),h=try Harness(),legacy=try h.directory("home/Library/Application Support/Convo Caddy/workspace",files:["a":"evidence"]),destination=try h.directory("preserve",files:[:]),checking=JournalCheckingPreserver(journal:journal)
        let firstOutcome=h.run(workspaces:[try h.target(legacy,.legacyNested)],preservation:destination,journal:journal,preserver:checking)
        #expect(firstOutcome.complete,"\(firstOutcome)");#expect(checking.sawWriteAhead)
        let h2=try Harness(),prior=OperationJournal(phase:.preserving,targets:[],workspaceChoice:.keep);journal.value=prior
        #expect(h2.run(journal:journal).blocked);#expect(h2.run(journal:journal,interruptedAcknowledged:true).complete);#expect(journal.value == nil)
    }

    @Test("recovery fresh under-lock inventory change requires renewed review")
    func recoveryFreshInventoryMismatch() throws {
        let h=try Harness(),changed=RemovalInventory(privateRoots:[],applicationBundles:[],workspaces:[],preferencesReadable:false)
        #expect(h.run(inventoryRefresher:FixedInventoryRefresher(changed)).blocked);#expect(h.fs.exists(h.privateRoot))
    }

    @Test("recovery manifest verifies metadata and propagates unsupported entry errors")
    func recoveryManifestMetadataAndErrors() throws {
        let h=try Harness(),source=try h.directory("metadata-source",files:["a":"bytes"]),destination=h.root.appendingPathComponent("metadata-copy"),preserver=WorkspacePreserver(),receipt=try preserver.preserve(source:h.target(source,.legacyNested),destination:destination)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:destination.appendingPathComponent("a").path)
        #expect(throws:PreservationError.verificationFailed){try preserver.verify(receipt)}
        let unsupported=try h.directory("unsupported",files:[:]);#expect(mkfifo(unsupported.appendingPathComponent("pipe").path,0o600)==0)
        #expect(throws:PreservationError.verificationFailed){try treeDigest(unsupported)}
    }

    @Test("review35 intermediate destination alias cannot destroy original and preservation")
    func review35IntermediateAlias() throws {
        let h = try Harness()
        let source = try h.directory("home/Library/Application Support/Convo Caddy/workspace", files: ["a":"irreplaceable"])
        let inside = try h.directory("home/Library/Application Support/Convo Caddy/backup/subdir", files: [:])
        let alias = h.root.appendingPathComponent("outside-alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: inside.deletingLastPathComponent())
        let outcome = h.run(workspaces: [try h.target(source,.legacyNested)], preservation: alias.appendingPathComponent("subdir"))
        #expect(!outcome.complete)
        #expect(h.fs.exists(source.appendingPathComponent("a")))
    }

    @Test("review35 interrupted deletion retry verifies and reports previous preservation")
    func review35InterruptedPreservationVerification() throws {
        let h=try Harness(), journal=MemoryJournal()
        let source=try h.directory("home/Library/Application Support/Convo Caddy/workspace", files:["a":"irreplaceable"])
        let destination=try h.directory("preserve",files:[:])
        let first=h.run(workspaces:[try h.target(source,.legacyNested)],preservation:destination,journal:journal,phaseBoundary:{if $0 == .verifying{throw TestError.injected}})
        #expect(first.incomplete)
        #expect(!h.fs.exists(source))
        let published=destination.appendingPathComponent("Convo Caddy Preserved Workspace/a")
        try "corrupted".write(to:published,atomically:true,encoding:.utf8)
        let retry=h.run(journal:journal,interruptedAcknowledged:true)
        #expect(!retry.complete)
        #expect(journal.value != nil)
    }

    @Test("review37 dangling preference evidence cannot become an empty workspace list")
    func review37DanglingPreferences() throws {
        let h=try Harness(), config=try h.directory("home/Library/Application Support/Convo Caddy/config",files:[:])
        try FileManager.default.createSymbolicLink(at:config.appendingPathComponent("preferences.json"),withDestinationURL:h.root.appendingPathComponent("missing"))
        let inventory=try ProductionInventory.build(home:h.home,applicationCandidates:[])
        #expect(!inventory.preferencesReadable)
        #expect(h.run(inventory:inventory).blocked)
        #expect(h.fs.exists(h.privateRoot))
    }

    @Test("review37 changed recovery bytes require fresh consent even with the same support inode")
    func review37ChangedCheckpoint() throws {
        let h=try Harness()
        let checkpoint=h.privateRoot.appendingPathComponent("active-session.json")
        try Data("first".utf8).write(to:checkpoint)
        let confirmed=try ProductionInventory.build(home:h.home,applicationCandidates:[])
        try Data("second".utf8).write(to:checkpoint)
        let fresh=try ProductionInventory.build(home:h.home,applicationCandidates:[]), base=try h.directory("preserve",files:[:])
        #expect(h.run(inventory:confirmed,preservation:base,inventoryRefresher:FixedInventoryRefresher(fresh)).blocked)
        #expect(h.fs.exists(checkpoint))
    }

    @Test("review37 unsafe maintenance inode and ancestor fail before body")
    func review37UnsafeLock() throws {
        let h=try Harness(), control=try h.directory("control",files:[:]), alias=h.root.appendingPathComponent("alias")
        try FileManager.default.setAttributes([.posixPermissions:0o700],ofItemAtPath:control.path)
        try FileManager.default.createSymbolicLink(at:alias,withDestinationURL:control)
        #expect(throws:(any Error).self) { try DarwinMaintenanceLock(lockURL:alias.appendingPathComponent("lock")).withExclusiveLock { Issue.record("entered through alias") } }
        let marker=control.appendingPathComponent("public.lock")
        try Data().write(to:marker)
        try FileManager.default.setAttributes([.posixPermissions:0o644],ofItemAtPath:marker.path)
        #expect(throws:(any Error).self) { try DarwinMaintenanceLock(lockURL:marker).withExclusiveLock { Issue.record("entered with public marker") } }
    }

    @Test("review37 resource fork cannot be silently lost by keep preservation")
    func review37ResourceFork() throws {
        let h=try Harness(), source=try h.directory("legacy",files:["unknown":"data"]), destination=h.root.appendingPathComponent("preserved")
        let file=source.appendingPathComponent("unknown"), bytes=Array("important fork".utf8)
        let status=bytes.withUnsafeBytes { setxattr(file.path,"com.apple.ResourceFork",$0.baseAddress,$0.count,0,0) }
        #expect(status == 0)
        #expect(throws:(any Error).self) { _ = try WorkspacePreserver().prepare(source:WorkspaceTarget(url:source,kind:.legacyNested,identity:DescriptorFileSystem().identity(source)),destination:destination,operationID:UUID()) }
        #expect(FileManager.default.fileExists(atPath:file.path))
        #expect(!FileManager.default.fileExists(atPath:destination.path))
    }

    @Test("review37 dedicated classification cannot delete shared parents or control")
    func review37SharedParents() throws {
        let h=try Harness()
        for relative in ["Documents","Downloads","Desktop","Library/Application Support","Library/Application Support/Convo Caddy Control"] {
            let target=try h.directory("home/"+relative,files:["unknown":"keep"])
            let workspace=WorkspaceTarget(url:target,kind:.dedicated,identity:try DescriptorFileSystem().identity(target))
            let outcome=h.run(inventory:.init(privateRoots:[],applicationBundles:[],workspaces:[workspace]),choice:.deleteDedicated,destructive:true)
            guard case .blocked = outcome else { Issue.record("shared parent was not blocked: \(relative)");continue }
            #expect(FileManager.default.fileExists(atPath:target.appendingPathComponent("unknown").path))
        }
    }

    @Test("review36 recovery rechecks descendant durability")
    func review36RetryFileSyncFailure() throws {
        let h=try Harness(), journal=MemoryJournal()
        let source=try h.directory("home/Library/Application Support/Convo Caddy/workspace",files:["a":"keep"]), base=try h.directory("preserve",files:[:]), target=try h.target(source,.legacyNested)
        let failing=WorkspacePreserver(synchronize:{ fd in
            var info=stat();guard fstat(fd,&info)==0 else{return -1}
            return (info.st_mode&S_IFMT)==S_IFREG ? -1 : fsync(fd)
        })
        #expect(h.run(workspaces:[target],preservation:base,journal:journal,preserver:failing).incomplete)
        #expect(h.run(workspaces:[target],preservation:base,journal:journal,preserver:failing,interruptedAcknowledged:true).incomplete)
        #expect(h.fs.exists(source.appendingPathComponent("a")))
        #expect(h.run(workspaces:[target],preservation:base,journal:journal,interruptedAcknowledged:true).complete)
    }

    @Test("review36 file journal retry retains interrupted temporary evidence")
    func review36JournalTemporaryCollision() throws {
        let h=try Harness(), directory=try h.directory("journal",files:[:])
        let journal=FileOperationJournal(url:directory.appendingPathComponent("operation.json"))
        var operation=OperationJournal(targets:[],workspaceChoice:.keep)
        try journal.save(operation)
        let leftover=directory.appendingPathComponent(".operation-\(operation.operationID.uuidString).tmp")
        try Data("interrupted evidence".utf8).write(to:leftover)
        operation.phase = .exclusive
        try journal.save(operation)
        #expect(try journal.load()?.phase == .exclusive)
        #expect(try Data(contentsOf:leftover) == Data("interrupted evidence".utf8))
    }

    @Test("review36 rejects replacement staging before publication")
    func review36StagingReplacement() throws {
        let h=try Harness(), source=try h.directory("source",files:["a":"keep"]), base=try h.directory("preserve",files:[:])
        let target=try h.target(source,.legacyNested)
        let plan=try WorkspacePreserver().prepare(source:target,destination:base.appendingPathComponent("copy"),operationID:UUID())
        let preserver=WorkspacePreserver { boundary in
            if boundary == .beforePublish {
                let stage=base.appendingPathComponent(plan.stagingName), moved=base.appendingPathComponent("original-stage")
                try FileManager.default.moveItem(at:stage,to:moved)
                try FileManager.default.copyItem(at:moved,to:stage)
            }
        }
        #expect(throws:(any Error).self){try preserver.execute(plan)}
        #expect(h.fs.exists(source.appendingPathComponent("a")))
        #expect(!h.fs.exists(plan.destination))
    }

    @Test("review36 retry cannot delete its own preserved copy")
    func review36ReceiptInsideNewDeletionRoot() throws {
        let h=try Harness(), journal=MemoryJournal()
        let source=try h.directory("home/Library/Application Support/Convo Caddy/workspace",files:["a":"keep"])
        let base=try h.directory("preserve",files:[:])
        let failed=h.run(workspaces:[try h.target(source,.legacyNested)],preservation:base,journal:journal,phaseBoundary:{if $0 == .deleting {throw TestError.injected}})
        #expect(failed.incomplete)
        let receipt=try #require(journal.value?.preservation.first?.receipt)
        let retry=h.run(workspaces:[try h.target(base,.dedicated)],choice:.deleteDedicated,destructive:true,journal:journal,interruptedAcknowledged:true)
        #expect(!retry.complete)
        #expect(h.fs.exists(receipt.destination.appendingPathComponent("a")))
        #expect(h.fs.exists(source.appendingPathComponent("a")))
    }

    @Test(arguments: [PreservationBoundary.beforeCopy, .afterCopy, .beforeSync, .afterSync, .beforePublish, .afterPublish])
    func review36PartialPreservationRetry(interruption: PreservationBoundary) throws {
        let h=try Harness(), journal=MemoryJournal()
        let source=try h.directory("home/Library/Application Support/Convo Caddy/workspace",files:["a":"keep"])
        let destination=try h.directory("preserve",files:[:])
        let target=try h.target(source,.legacyNested)
        let failed=h.run(workspaces:[target],preservation:destination,journal:journal,preserver:WorkspacePreserver { if $0 == interruption { throw TestError.injected } })
        #expect(failed.incomplete); #expect(h.fs.exists(source))
        let retry=h.run(workspaces:[target],preservation:destination,journal:journal,interruptedAcknowledged:true)
        #expect(retry.complete)
        #expect(h.fs.exists(destination.appendingPathComponent("Convo Caddy Preserved Workspace/a")))
    }

    @Test("review35 restart retains verified receipt in final result")
    func review35RestartReportsPreservedLocation() throws {
        let h=try Harness(), journal=MemoryJournal()
        let source=try h.directory("home/Library/Application Support/Convo Caddy/workspace",files:["a":"keep"])
        let destination=try h.directory("preserve",files:[:])
        #expect(h.run(workspaces:[try h.target(source,.legacyNested)],preservation:destination,journal:journal,phaseBoundary:{if $0 == .verifying{throw TestError.injected}}).incomplete)
        let retry=h.run(journal:journal,interruptedAcknowledged:true)
        guard case let .complete(retained, removed) = retry else { Issue.record("Retry must complete: \(retry)"); return }
        #expect(retained.map(\.path) == [destination.appendingPathComponent("Convo Caddy Preserved Workspace").path]); #expect(removed == 0)
    }

    @Test("native UI model defaults No and reveals exact paths only after Yes")
    func ui() {
        var model = UninstallReviewModel(); #expect(model.decision(paths: []) == .keep); #expect(model.defaultWorkspaceAnswer == "No")
        model.deleteWorkspace = true; let path = URL(fileURLWithPath: "/fixture/workspace"); #expect(model.decision(paths: [path]) == .reviewDeletion(paths: [path]))
    }
}

private func assertW6Original(parent:URL,evidence:URL,bytes:Data,identity:FileIdentity,metadata:[FileAttributeKey:Any],digest:String,fs:FileSystemPort)throws {
    #expect(fs.exists(parent));#expect(fs.exists(evidence));#expect(try fs.identity(evidence)==identity)
    let after=try Data(contentsOf:evidence);#expect(after.count==bytes.count);#expect(after==bytes)
    let current=try FileManager.default.attributesOfItem(atPath:evidence.path)
    for key in [FileAttributeKey.type,.size,.posixPermissions,.modificationDate] { #expect(String(describing:current[key])==String(describing:metadata[key])) }
    #expect(try treeDigest(parent)==digest)
    #expect(try String(contentsOf:parent.appendingPathComponent("ordinary.keep"),encoding:.utf8)=="ordinary-sentinel")
    #expect(try String(contentsOf:parent.appendingPathComponent(".hidden-keep"),encoding:.utf8)=="hidden-sentinel")
}

private enum TestError: Error { case denied, injected }
private final class FakeKeychain: KeychainPort, @unchecked Sendable {
    let rows: [CredentialReference], failure: Error?, retainAfterDelete: Bool; var requested=[String](), deleted=[CredentialReference](), secretReads=0
    init(rows: [CredentialReference], failure: Error? = nil, retainAfterDelete: Bool = false) { self.rows=rows; self.failure=failure; self.retainAfterDelete=retainAfterDelete }
    func references(service: String) throws -> [CredentialReference] { requested.append(service); if let failure { throw failure }; return retainAfterDelete ? rows : rows.filter { !deleted.contains($0) } }
    func delete(reference: CredentialReference) throws { deleted.append(reference) }
}
private final class FakeProcesses: ProcessPort, @unchecked Sendable {
    let current: [URL], legacy: [URL]; var kills=0, remoteMutations=0
    init(current: [URL] = [], legacy: [URL] = []) { self.current=current; self.legacy=legacy }
    func currentAppProcesses() -> [URL] { current }; func legacyOrUnknownProcesses() -> [URL] { legacy }
}
private final class MemoryJournal: JournalPort, @unchecked Sendable { var value: OperationJournal?;var archived:[UUID]=[]; func load() throws -> OperationJournal? { value };func archiveExisting(_ journal:OperationJournal)throws{archived.append(journal.operationID);value=nil}; func save(_ journal: OperationJournal) throws { value=journal }; func remove() throws { value=nil } }
private struct FixedInventoryRefresher:InventoryRefreshing { let value:RemovalInventory;init(_ value:RemovalInventory){self.value=value};func freshInventory(confirmed:RemovalInventory)throws->RemovalInventory{value} }
private final class JournalCheckingPreserver:WorkspacePreserving,@unchecked Sendable { let journal:MemoryJournal,real=WorkspacePreserver();var sawWriteAhead=false;init(journal:MemoryJournal){self.journal=journal};func prepare(source:WorkspaceTarget,destination:URL,operationID:UUID)throws->PreservationPlan{try real.prepare(source:source,destination:destination,operationID:operationID)};func execute(_ plan:PreservationPlan)throws->PreservationReceipt{sawWriteAhead=journal.value?.preservation.contains(where:{$0.plan==plan})==true;return try real.execute(plan)};func verify(_ receipt:PreservationReceipt)throws{try real.verify(receipt)} }
private struct ImmediateLock: MaintenanceLocking { func withExclusiveLock<T>(_ body: () throws -> T) throws -> T { try body() } }
private final class ManualCancellation: CancellationPort, @unchecked Sendable { var cancelled = false; func isCancelled() -> Bool { cancelled } }
private struct FixedCancellation: CancellationPort { let value: Bool; init(_ value:Bool){self.value=value}; func isCancelled()->Bool{value} }
private final class BoundaryCancellation: CancellationPort, @unchecked Sendable { private var checks=0;let cancelAfterChecks:Int;init(cancelAfterChecks:Int){self.cancelAfterChecks=cancelAfterChecks};func isCancelled()->Bool{defer{checks += 1};return checks > cancelAfterChecks} }
private final class FailingFileSystem: FileSystemPort, @unchecked Sendable {
    let real=DescriptorFileSystem(); var escalations=0
    func identity(_ url: URL) throws -> FileIdentity { try real.identity(url) }; func removeTree(_ url: URL, expected: FileIdentity) throws { throw FileSystemError.permissionDenied }; func exists(_ url: URL) -> Bool { real.exists(url) }
}
private final class IdentityFaultFileSystem: FileSystemPort, @unchecked Sendable {
    let real = DescriptorFileSystem(), fault: FileSystemError
    var removalAttempts = 0
    init(fault: FileSystemError) { self.fault = fault }
    func identity(_ url: URL) throws -> FileIdentity { try real.identity(url) }
    func removeTree(_ url: URL, expected: FileIdentity) throws { removalAttempts += 1; throw fault }
    func exists(_ url: URL) -> Bool { real.exists(url) }
}
private final class Harness {
    let root: URL, home: URL, privateRoot: URL, fs: FileSystemPort, processes: FakeProcesses
    init(fs: FileSystemPort? = nil, processes: FakeProcesses = FakeProcesses()) throws {
        let temporaryPath = FileManager.default.temporaryDirectory.path
        let canonicalTemporaryPath = temporaryPath.hasPrefix("/var/") ? "/private\(temporaryPath)" : temporaryPath
        root=URL(fileURLWithPath: canonicalTemporaryPath).appendingPathComponent("cc-u1-\(UUID())"); home=root.appendingPathComponent("home"); privateRoot=home.appendingPathComponent("Library/Application Support/Convo Caddy")
        try FileManager.default.createDirectory(at: privateRoot, withIntermediateDirectories: true); try "private".write(to: privateRoot.appendingPathComponent("state"), atomically: true, encoding: .utf8); self.fs=fs ?? DescriptorFileSystem(); self.processes=processes
    }
    deinit { try? FileManager.default.removeItem(at: root) }
    func directory(_ relative: String, files: [String:String]) throws -> URL { let directory=root.appendingPathComponent(relative); try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true); for (name,body) in files { let file=directory.appendingPathComponent(name); try FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true); try body.write(to:file,atomically:true,encoding:.utf8) }; return directory }
    func target(_ url: URL, _ kind: WorkspaceKind) throws -> WorkspaceTarget {
        let identity=try fs.identity(url)
        if kind == .dedicated {
            let value:[String:Any] = ["schemaVersion":1,"application":caddyBundleIdentifier,"device":String(identity.device),"inode":String(identity.inode)]
            try JSONSerialization.data(withJSONObject:value).write(to:url.appendingPathComponent(".convo-caddy-workspace.json"))
        }
        return .init(url:url,kind:kind,identity:identity)
    }
    func run(inventory: RemovalInventory? = nil, workspaces: [WorkspaceTarget] = [], choice: WorkspaceChoice = .keep, destructive: Bool = false, confirmed: Bool = true, preservation: URL? = nil, cancellation: CancellationPort = NeverCancelled(), journal:MemoryJournal=MemoryJournal(),preserver:WorkspacePreserving=WorkspacePreserver(),inventoryRefresher:InventoryRefreshing?=nil,interruptedAcknowledged:Bool=false, phaseBoundary: @escaping @Sendable (OperationPhase) throws -> Void = { _ in }) -> UninstallOutcome {
        let value=inventory ?? .init(privateRoots:fs.exists(privateRoot) ? [privateRoot]:[],applicationBundles:[],workspaces:workspaces)
        return UninstallCoordinator(home:home,fs:fs,lock:ImmediateLock(),processes:processes,journal:journal,keychain:KeychainCleaner(port:FakeKeychain(rows:[])),preserver:preserver,cancellation:cancellation,inventoryRefresher:inventoryRefresher,phaseBoundary:phaseBoundary).run(.init(inventory:value,choice:choice,confirmed:confirmed,destructiveWorkspaceConfirmed:destructive,preservationDestination:preservation,interruptedOperationAcknowledged:interruptedAcknowledged))
    }
}
private extension UninstallOutcome { var complete: Bool { if case .complete = self { true } else { false } }; var blocked: Bool { if case .blocked = self { true } else { false } }; var incomplete: Bool { if case .incomplete = self { true } else { false } } }
private extension KeychainCleanupResult { var incomplete: Bool { if case .incomplete = self { true } else { false } } }
