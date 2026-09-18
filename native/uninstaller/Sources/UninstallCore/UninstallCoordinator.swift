import CryptoKit
import Darwin
import Foundation

public enum UninstallOutcome:Equatable,Sendable { case complete(retained:[URL],removedCredentials:Int),blocked(String),incomplete(String) }
public protocol ProcessPort:Sendable { func currentAppProcesses()->[URL];func legacyOrUnknownProcesses()->[URL] }
public protocol MaintenanceLocking:Sendable { func withExclusiveLock<T>(_ body:()throws->T)throws->T }
public protocol CancellationPort:Sendable { func isCancelled()->Bool }
public struct NeverCancelled:CancellationPort,Sendable { public init(){};public func isCancelled()->Bool{false} }
public protocol InventoryRefreshing:Sendable { func freshInventory(confirmed:RemovalInventory)throws->RemovalInventory }
public struct IdentityInventoryRefresher:InventoryRefreshing,Sendable {
    let fs:FileSystemPort;public init(fs:FileSystemPort){self.fs=fs}
    public func freshInventory(confirmed:RemovalInventory)throws->RemovalInventory{
        for workspace in confirmed.workspaces { guard fs.exists(workspace.url),try fs.identity(workspace.url)==workspace.identity else{throw FileSystemError.identityChanged}  }
        for(path,identity) in confirmed.confirmedTargetIdentities{let url=URL(fileURLWithPath:path);guard fs.exists(url),try fs.identity(url)==identity else{throw FileSystemError.identityChanged}}
        return confirmed
    }
}
public struct ProductionInventoryRefresher:InventoryRefreshing,Sendable { let home:URL;public init(home:URL){self.home=home};public func freshInventory(confirmed:RemovalInventory)throws->RemovalInventory{try ProductionInventory.build(home:home)} }

public struct DarwinMaintenanceLock:MaintenanceLocking,Sendable {
    public let lockURL:URL;public init(lockURL:URL){self.lockURL=lockURL}
    public func withExclusiveLock<T>(_ body:()throws->T)throws->T{
        let directory=lockURL.deletingLastPathComponent();try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]);var directoryInfo=stat()
        guard lstat(directory.path,&directoryInfo)==0,(directoryInfo.st_mode&S_IFMT)==S_IFDIR,directoryInfo.st_uid==getuid(),(directoryInfo.st_mode&0o077)==0 else{throw FileSystemError.permissionDenied}
        let directoryFD=try openNoFollowPath(directory,directory:true);defer{close(directoryFD)}
        guard fstat(directoryFD,&directoryInfo)==0,directoryInfo.st_uid==getuid(),(directoryInfo.st_mode&0o077)==0 else{throw FileSystemError.permissionDenied}
        let fd=openat(directoryFD,lockURL.lastPathComponent,O_RDWR|O_CREAT|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK,S_IRUSR|S_IWUSR)
        guard fd>=0 else{throw FileSystemError.io(String(cString:strerror(errno)))};defer{close(fd)}
        var info=stat();guard fstat(fd,&info)==0,info.st_uid==getuid(),info.st_nlink==1,(info.st_mode&S_IFMT)==S_IFREG,(info.st_mode&0o077)==0 else{throw FileSystemError.identityChanged}
        guard flock(fd,LOCK_EX|LOCK_NB)==0 else{throw FileSystemError.io("Convo Caddy is running or another uninstaller owns maintenance.")};defer{flock(fd,LOCK_UN)}
        var current=stat();guard fstatat(directoryFD,lockURL.lastPathComponent,&current,AT_SYMLINK_NOFOLLOW)==0,current.st_dev==info.st_dev,current.st_ino==info.st_ino else{throw FileSystemError.identityChanged}
        return try body()
    }
}

public struct UninstallRequest:Sendable {
    public let inventory:RemovalInventory,choice:WorkspaceChoice,confirmed:Bool,destructiveWorkspaceConfirmed:Bool,preservationDestination:URL?,interruptedOperationAcknowledged:Bool
    public init(inventory:RemovalInventory,choice:WorkspaceChoice,confirmed:Bool,destructiveWorkspaceConfirmed:Bool=false,preservationDestination:URL?=nil,interruptedOperationAcknowledged:Bool=false){self.inventory=inventory;self.choice=choice;self.confirmed=confirmed;self.destructiveWorkspaceConfirmed=destructiveWorkspaceConfirmed;self.preservationDestination=preservationDestination;self.interruptedOperationAcknowledged=interruptedOperationAcknowledged}
}

public final class UninstallCoordinator:@unchecked Sendable {
    private let home:URL,fs:FileSystemPort,lock:MaintenanceLocking,processes:ProcessPort,journal:JournalPort,keychain:KeychainCleaner,preserver:WorkspacePreserving,cancellation:CancellationPort,inventoryRefresher:InventoryRefreshing
    private let phaseBoundary:@Sendable(OperationPhase)throws->Void
    public init(home:URL,fs:FileSystemPort,lock:MaintenanceLocking,processes:ProcessPort,journal:JournalPort,keychain:KeychainCleaner,preserver:WorkspacePreserving=WorkspacePreserver(),cancellation:CancellationPort=NeverCancelled(),inventoryRefresher:InventoryRefreshing?=nil,phaseBoundary:@escaping @Sendable(OperationPhase)throws->Void={_ in}){self.home=home;self.fs=fs;self.lock=lock;self.processes=processes;self.journal=journal;self.keychain=keychain;self.preserver=preserver;self.cancellation=cancellation;self.inventoryRefresher=inventoryRefresher ?? IdentityInventoryRefresher(fs:fs);self.phaseBoundary=phaseBoundary}
    public func run(_ request:UninstallRequest)->UninstallOutcome{
        guard request.confirmed else{return .blocked("Confirm uninstall before removing files.")};if request.choice != .keep && !request.destructiveWorkspaceConfirmed{return .blocked("Choose Yes to confirm workspace deletion.")}
        do{try InventoryBuilder().validate(request.inventory,home:home);if request.choice == .deleteDedicated { for workspace in request.inventory.workspaces { guard workspace.kind == .dedicated, ProductionInventory.hasDedicatedOwnership(workspace.url) else { throw InventoryError.unsafePath("This older workspace has no verified dedicated-folder ownership. Keep it during uninstall; review old external files manually. No migration or adoption was performed.") }; try PathGuard(home:home).requireSafeRecursiveWorkspace(workspace.url) } }}catch{return .blocked("Unsafe or unreadable inventory: \(error)")};guard processes.currentAppProcesses().isEmpty else{return .blocked("Quit Convo Caddy and check again; deletion is disabled while it runs.")};guard processes.legacyOrUnknownProcesses().isEmpty else{return .blocked("A legacy or unknown Caddy process must remain stopped throughout removal; unrelated services were not changed.")}
        do{
            return try lock.withExclusiveLock{
                let prior=try journal.load();guard prior==nil || request.interruptedOperationAcknowledged else{return .blocked("A previous uninstall was interrupted. Reopen the uninstaller and choose again.")}

                guard processes.currentAppProcesses().isEmpty && processes.legacyOrUnknownProcesses().isEmpty else{return .blocked("A Caddy process restarted during the quiescence check.")}
                let fresh=try RetryInventory.reconcile(inventoryRefresher.freshInventory(confirmed:request.inventory),prior:prior,home:home);guard inventoryMatchesConfirmation(confirmed:request.inventory,fresh:fresh) else{return .blocked("Files changed after your choice. Reopen the uninstaller and try again; nothing was removed.")}
                // Prior receipts remain authoritative evidence, never discarded by retry.
                var recovered = prior
                if var pending = recovered {
                    for index in pending.preservation.indices {
                        let entry = pending.preservation[index]
                        if let receipt = entry.receipt { try preserver.verify(receipt); continue }
                        guard fresh.workspaces.contains(where: { $0.url == entry.plan.source.url && $0.identity == entry.plan.source.identity }) || fresh.privateRoots.contains(where: { $0.standardizedFileURL.path == entry.plan.source.url.standardizedFileURL.path && fresh.confirmedTargetIdentities[$0.standardizedFileURL.path] == entry.plan.source.identity }) else { throw PreservationError.sourceChanged }
                        guard let destination=request.preservationDestination, destination.standardizedFileURL.path == entry.plan.destination.deletingLastPathComponent().standardizedFileURL.path else { return .blocked("Choose the original folder used to save the workspace, then try again.") }
                        let receipt=try preserver.execute(entry.plan, staged: { pinned in
                            pending.preservation[index] = .init(plan:pinned)
                            try journal.save(pending)
                        })
                        pending.preservation[index].receipt=receipt
                        try journal.save(pending)
                    }
                    recovered=pending
                }
                return try execute(request,fresh:fresh,prior:recovered)
            }
        }catch{return .incomplete("Removal stopped safely: \(error)")}
    }
    private func execute(_ request:UninstallRequest,fresh:RemovalInventory,prior:OperationJournal?)throws->UninstallOutcome{
        var retained:[URL]=prior?.preservation.compactMap { $0.receipt?.destination } ?? [],targets=fresh.privateRoots+fresh.applicationBundles,targetIdentities=fresh.confirmedTargetIdentities
        for workspace in fresh.workspaces{
            switch request.choice{
            case .keep:retained.append(workspace.url)
            case .deleteDedicated where workspace.kind == .dedicated:try PathGuard(home:home).requireSafeRecursiveWorkspace(workspace.url);targets.append(workspace.url);targetIdentities[workspace.url.standardizedFileURL.path]=workspace.identity
            default:retained.append(workspace.url)
            }
        }
        if request.choice != .keep,retained.contains(where:{kept in targets.contains(where:{workspacePathContains($0,kept)})}){return .blocked("A retained workspace is inside a private removal root. Preserve it outside private state and review again; nothing was removed.")}
        targets=Array(Set(targets)).filter{candidate in !targets.contains(where:{candidate != $0 && workspacePathContains($0,candidate)})}.sorted{$0.path<$1.path}
        var records=try targets.filter(fs.exists).map{url->JournalTarget in let path=url.standardizedFileURL.path;let expected:FileIdentity;if let confirmed=targetIdentities[path]{expected=confirmed}else{expected=try fs.identity(url)};guard try fs.identity(url)==expected else{throw FileSystemError.identityChanged};return .init(path:path,identity:expected)}
        let operationID=prior?.operationID ?? UUID();var operation=OperationJournal(operationID:operationID,phase:.confirmed,targets:records,workspaceChoice:request.choice,preservation:prior?.preservation ?? []);operation.reviewedWorkspaces=fresh.workspaces;operation.inventoryDigest=try inventoryDigest(fresh);try journal.save(operation);try phaseBoundary(.confirmed);operation.phase = .exclusive;try journal.save(operation);try phaseBoundary(.exclusive)
        guard !cancellation.isCancelled() else{operation.phase = .incomplete;operation.errorCategory="cancelled-before-mutation";try journal.save(operation);return .incomplete("Removal was cancelled before mutation; local data is unchanged.")}
        let needingPreservation=fresh.workspaces.filter{workspace in request.choice == .keep && targets.contains(where:{workspacePathContains($0,workspace.url)})}
        var receipts:[PreservationReceipt]=operation.preservation.compactMap { $0.receipt }
        for(index,workspace) in needingPreservation.enumerated(){
            if let previous=operation.preservation.first(where:{$0.plan.source.url == workspace.url}) {
                guard previous.plan.source.identity == workspace.identity, let receipt=previous.receipt,
                      try treeDigest(workspace.url) == receipt.digest else { throw PreservationError.sourceChanged }
                try preserver.verify(receipt); retained.removeAll{$0 == workspace.url}; continue
            }
            guard let base=request.preservationDestination else{return .blocked("Choose a safe destination outside deletion roots before removal.")};let name=(index==0 ? "Convo Caddy Preserved Workspace":"Convo Caddy Preserved Workspace \(index+1)");let destination=base.appendingPathComponent(name);guard !targets.contains(where:{workspacePathContains($0,destination)}) else{return .blocked("The preservation destination is inside a deletion root; source data was retained.")};let plan=try preserver.prepare(source:workspace,destination:destination,operationID:operationID);operation.phase = .preserving;operation.preservation.append(.init(plan:plan));operation.preservationDestination=base.path;try journal.save(operation);try phaseBoundary(.preserving);let receipt=try preserver.execute(plan, staged: { pinned in operation.preservation[operation.preservation.count-1] = .init(plan:pinned); try journal.save(operation) });operation.preservation[operation.preservation.count-1].receipt=receipt;receipts.append(receipt);try journal.save(operation);retained.removeAll{$0==workspace.url};retained.append(receipt.destination)}
        if !receipts.isEmpty{operation.phase = .preserved;try journal.save(operation);try phaseBoundary(.preserved)}
        operation.phase = .deleting;try journal.save(operation);try phaseBoundary(.deleting)
        for index in records.indices{try phaseBoundary(.deleting);if cancellation.isCancelled(){operation.phase = .incomplete;operation.errorCategory="cancelled-during-deletion";try journal.save(operation);return .incomplete("Uninstall cancelled. Items already removed cannot be restored.")};guard processes.currentAppProcesses().isEmpty && processes.legacyOrUnknownProcesses().isEmpty else{throw FileSystemError.io("A Caddy process restarted; removal stopped.")};for preservation in operation.preservation{guard let receipt=preservation.receipt else{throw PreservationError.verificationFailed};try preserver.verify(receipt);if fs.exists(preservation.plan.source.url){guard try fs.identity(preservation.plan.source.url)==preservation.plan.source.identity,try treeDigest(preservation.plan.source.url)==receipt.digest else{throw PreservationError.sourceChanged}}};try fs.removeTree(URL(fileURLWithPath:records[index].path),expected:records[index].identity);records[index].complete=true;operation.targets=records;try journal.save(operation)}
        operation.phase = .verifying;try journal.save(operation);try phaseBoundary(.verifying);guard records.allSatisfy({!fs.exists(URL(fileURLWithPath:$0.path))}) else{return .incomplete("One or more local targets remain.")};for receipt in receipts{try preserver.verify(receipt)};guard processes.currentAppProcesses().isEmpty && processes.legacyOrUnknownProcesses().isEmpty else{throw FileSystemError.io("A Caddy process restarted before final verification.")}
        for workspace in fresh.workspaces where retained.contains(workspace.url) {
            guard fs.exists(workspace.url),try fs.identity(workspace.url)==workspace.identity else {
                operation.phase = .incomplete;operation.errorCategory="retained-workspace-unavailable";try journal.save(operation)
                return .incomplete("Private removal ran, but the retained workspace is now missing or changed. It cannot be reported as retained; credential cleanup has not run.")
            }
        }
        guard !cancellation.isCancelled() else { operation.phase = .incomplete; operation.errorCategory = "cancelled-before-credentials"; try journal.save(operation); return .incomplete("Removal cancelled before credential cleanup; already removed files cannot be restored.") }
        switch keychain.clean(){case let .complete(removed):operation.phase = .complete;try journal.save(operation);try journal.remove();return .complete(retained:retained,removedCredentials:removed);case let .incomplete(_,reason):operation.phase = .incomplete;operation.errorCategory="keychain";try journal.save(operation);return .incomplete(reason)}
    }
    private func inventoryMatchesConfirmation(confirmed:RemovalInventory,fresh:RemovalInventory)->Bool{
        guard confirmed.evidenceDigests == fresh.evidenceDigests, confirmed.preferencesReadable==fresh.preferencesReadable,confirmed.confirmedTargetIdentities==fresh.confirmedTargetIdentities,Set(confirmed.privateRoots.map{$0.standardizedFileURL.path})==Set(fresh.privateRoots.map{$0.standardizedFileURL.path}),Set(confirmed.applicationBundles.map{$0.standardizedFileURL.path})==Set(fresh.applicationBundles.map{$0.standardizedFileURL.path}),confirmed.possiblyUnfinishedCapture==fresh.possiblyUnfinishedCapture else{return false}
        guard confirmed.workspaces.count==fresh.workspaces.count else{return false};return confirmed.workspaces.allSatisfy{approved in fresh.workspaces.contains{current in approved.url.standardizedFileURL.path==current.url.standardizedFileURL.path && approved.identity==current.identity && approved.kind==current.kind}}
    }
    private func inventoryDigest(_ inventory:RemovalInventory)throws->String{let encoder=JSONEncoder();encoder.outputFormatting=[.sortedKeys];return SHA256.hash(data:try encoder.encode(inventory)).map{String(format:"%02x",$0)}.joined()}

}
public struct EmptyProcessPort:ProcessPort,Sendable { public init(){};public func currentAppProcesses()->[URL]{[]};public func legacyOrUnknownProcesses()->[URL]{[]} }
