import Foundation
import Testing
@testable import UninstallCore

private struct AuditNoKeys: KeychainPort { func references(service:String)throws->[CredentialReference]{[]};func delete(reference:CredentialReference)throws{throw NSError(domain:"forbidden-real-keychain",code:1)} }
private struct AuditLock: MaintenanceLocking { func withExclusiveLock<T>(_ body:()throws->T)throws->T{try body()} }
private final class AuditJournal:JournalPort,@unchecked Sendable { var value:OperationJournal?;func load()throws->OperationJournal?{value};func save(_ j:OperationJournal)throws{value=j};func remove()throws{value=nil};func archiveExisting(_ j:OperationJournal)throws{value=nil} }
private struct AuditRefresh:InventoryRefreshing {let home:URL;func freshInventory(confirmed:RemovalInventory)throws->RemovalInventory{try ProductionInventory.build(home:home,applicationCandidates:[])}}
private final class AuditFixture {
 let root:URL,home:URL,support:URL
 init()throws{root=FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("caddy-delete-audit-\(UUID())");home=root.appendingPathComponent("home");support=home.appendingPathComponent("Library/Application Support/Convo Caddy");try FileManager.default.createDirectory(at:support,withIntermediateDirectories:true)}
 // Only this newly created UUID fixture is eligible for cleanup.
 deinit{if root.lastPathComponent.hasPrefix("caddy-delete-audit-"){try? FileManager.default.removeItem(at:root)}}
 func file(_ relative:String,_ text:String="IMPORTANT SYNTHETIC SENTINEL")throws->URL{let u=home.appendingPathComponent(relative);try FileManager.default.createDirectory(at:u.deletingLastPathComponent(),withIntermediateDirectories:true);try text.write(to:u,atomically:true,encoding:.utf8);return u}
 func prefs(_ path:String?)throws{let o:[String:Any] = ["schemaVersion":2,"workspaceRoot":path as Any? ?? NSNull()];let data=try JSONSerialization.data(withJSONObject:o);_ = try file("Library/Application Support/Convo Caddy/config/preferences.json",String(decoding:data,as:UTF8.self))}
 func run(_ choice:WorkspaceChoice = .keep,kind:WorkspaceKind?=nil,preservation:URL?=nil,phaseBoundary:@escaping @Sendable(OperationPhase)throws->Void={_ in})throws->UninstallOutcome{
  let i=try ProductionInventory.build(home:home,applicationCandidates:[])
  let classified=RemovalInventory(privateRoots:i.privateRoots,applicationBundles:[],workspaces:i.workspaces.map{w in WorkspaceTarget(url:w.url,kind:kind ?? w.kind,identity:w.identity)},preferencesReadable:i.preferencesReadable,possiblyUnfinishedCapture:i.possiblyUnfinishedCapture,confirmedTargetIdentities:i.confirmedTargetIdentities,evidenceDigests:i.evidenceDigests)
  return UninstallCoordinator(home:home,fs:DescriptorFileSystem(),lock:AuditLock(),processes:EmptyProcessPort(),journal:AuditJournal(),keychain:KeychainCleaner(port:AuditNoKeys()),inventoryRefresher:AuditRefresh(home:home),phaseBoundary:phaseBoundary).run(.init(inventory:classified,choice:choice,confirmed:true,destructiveWorkspaceConfirmed:choice != .keep,preservationDestination:preservation))
 }
}

@Test("Correction: missing/null preferences remove whole private support and retain outside sentinel") func correctionUnconfigured()throws {
 for nullPrefs in [false,true] { let f=try AuditFixture();let outside=try f.file("Documents/outside");_ = try f.file("Library/Application Support/Convo Caddy/unknown-private-content");if nullPrefs{try f.prefs(nil)}
 #expect(try f.run() == .complete(retained:[],removedCredentials:0));#expect(!FileManager.default.fileExists(atPath:f.support.path));#expect(FileManager.default.fileExists(atPath:outside.path)) }
}
@Test("Correction: case alias keep never claims retained after deleting source") func correctionCaseAlias()throws {
 let f=try AuditFixture();let sentinel=try f.file("Library/Application Support/Convo Caddy/interviews/important.txt");let alias=f.home.appendingPathComponent("Library/Application Support/convo caddy/interviews")
 try #require(FileManager.default.fileExists(atPath:alias.path), "Run this regression on the supported case-insensitive macOS volume")
 try f.prefs(alias.path)
 let inventory=try ProductionInventory.build(home:f.home,applicationCandidates:[]);#expect(UninstallReviewModel.needsPreservation(inventory))
 let outcome=try f.run();#expect(FileManager.default.fileExists(atPath:sentinel.path));if case .complete = outcome {Issue.record("Keep without preservation destination must not complete: \(outcome)")}
}
@Test("Correction: case alias keep preserves bytes through production inventory and refresher") func correctionCasePreservation()throws {
 let f=try AuditFixture();_ = try f.file("Library/Application Support/Convo Caddy/interviews/important.txt","retain me");let alias=f.home.appendingPathComponent("Library/Application Support/convo caddy/interviews");try #require(FileManager.default.fileExists(atPath:alias.path));try f.prefs(alias.path)
 let destination=f.home.appendingPathComponent("Documents");try FileManager.default.createDirectory(at:destination,withIntermediateDirectories:true)
 let outcome=try f.run(preservation:destination);let preserved=destination.appendingPathComponent("Convo Caddy Preserved Workspace")
 #expect({ if case let .complete(retained, count)=outcome { return retained.map(\.path) == [preserved.path] && count==0 }; return false }());#expect(try String(contentsOf:preserved.appendingPathComponent("important.txt"),encoding:.utf8)=="retain me")
}
@Test("Correction: old Documents root cannot be relabeled into recursive ownership") func correctionOldRoot()throws {
 let f=try AuditFixture();let sentinel=try f.file("Documents/project/unrelated");try f.prefs(f.home.appendingPathComponent("Documents/project").path)
 let outcome=try f.run(.deleteDedicated,kind:.dedicated)
 if case .complete = outcome {Issue.record("Unproven old root must block deletion")};#expect(FileManager.default.fileExists(atPath:sentinel.path))
}
@Test("Correction: durable workspace ownership authorizes only exact child keep or delete") func correctionDedicated()throws {
 for choice in [WorkspaceChoice.keep,.deleteDedicated] {
 let f=try AuditFixture();let outside=try f.file("Documents/outside");let sentinel=try f.file("Documents/Convo Caddy Workspace/inside");let workspace=sentinel.deletingLastPathComponent();let identity=try DescriptorFileSystem().identity(workspace)
 let marker:[String:Any] = ["schemaVersion":1,"application":"com.frameyard.convocaddy","device":String(identity.device),"inode":String(identity.inode)]
 try JSONSerialization.data(withJSONObject:marker).write(to:workspace.appendingPathComponent(".convo-caddy-workspace.json"));try f.prefs(workspace.path)
 let inventory=try ProductionInventory.build(home:f.home,applicationCandidates:[]);#expect(inventory.workspaces.first?.kind == .dedicated)
 let outcome=try f.run(choice);#expect(outcome == .complete(retained:choice == .keep ? [workspace] : [],removedCredentials:0));#expect(FileManager.default.fileExists(atPath:sentinel.path) == (choice == .keep));#expect(FileManager.default.fileExists(atPath:outside.path));#expect(!FileManager.default.fileExists(atPath:f.support.path))
 }
}

@Test("W4 old selected root remains intact under ordinary private uninstall") func correctionOldKeep()throws {
 let f=try AuditFixture();let sentinel=try f.file("Documents/important");try f.prefs(f.home.appendingPathComponent("Documents").path)
 let outcome=try f.run();#expect(outcome == .complete(retained:[sentinel.deletingLastPathComponent()],removedCredentials:0));#expect(FileManager.default.fileExists(atPath:sentinel.path));#expect(!FileManager.default.fileExists(atPath:f.support.path))
}

@Test("Correction: vanished retained workspace makes partial removal truthful") func correctionPartialRetention()throws {
 let f=try AuditFixture();let sentinel=try f.file("Documents/workspace/important");let root=sentinel.deletingLastPathComponent();try f.prefs(root.path)
 let outcome=try f.run(phaseBoundary:{if $0 == .verifying {try FileManager.default.removeItem(at:root)}})
 if case .incomplete = outcome {} else { Issue.record("Cannot claim a missing workspace retained: \(outcome)") }
 #expect(!FileManager.default.fileExists(atPath:f.support.path))
}

@Test("Workspace relocation journal prevents uninstall from erasing move recovery") func relocationJournalPreserved()throws {
 let f=try AuditFixture();_ = try f.file("Library/Application Support/Convo Caddy/config/workspace-move.json","{\"version\":1}")
 #expect(throws: InventoryError.self) { try ProductionInventory.build(home:f.home,applicationCandidates:[]) }
 #expect(FileManager.default.fileExists(atPath:f.support.path))
}
