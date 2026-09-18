import Darwin
import Foundation

public enum OperationPhase:String,Codable,Sendable { case inventory,confirmed,exclusive,preserving,preserved,deleting,verifying,complete,incomplete }
public enum WorkspaceChoice:String,Codable,Sendable { case keep,deleteDedicated }
public struct JournalTarget:Codable,Equatable,Sendable { public let path:String;public let identity:FileIdentity;public var complete:Bool;public init(path:String,identity:FileIdentity,complete:Bool=false){self.path=path;self.identity=identity;self.complete=complete} }
public struct PreservationJournal:Codable,Equatable,Sendable { public let plan:PreservationPlan;public var receipt:PreservationReceipt?;public init(plan:PreservationPlan,receipt:PreservationReceipt?=nil){self.plan=plan;self.receipt=receipt} }
public struct OperationJournal:Codable,Equatable,Sendable {
    public static let schemaVersion=2
    public let schemaVersion:Int;public let operationID:UUID;public var phase:OperationPhase;public var targets:[JournalTarget];public let workspaceChoice:WorkspaceChoice
    // Optional for compatibility with existing schema-v2 journals. Discovery only.
    public var reviewedWorkspaces:[WorkspaceTarget]?
    public var preservationDestination:String?;public var inventoryDigest:String?;public var preservation:[PreservationJournal];public var errorCategory:String?
    public init(operationID:UUID=UUID(),phase:OperationPhase = .inventory,targets:[JournalTarget],workspaceChoice:WorkspaceChoice,preservation:[PreservationJournal]=[]){schemaVersion=Self.schemaVersion;self.operationID=operationID;self.phase=phase;self.targets=targets;self.workspaceChoice=workspaceChoice;self.preservation=preservation}
}
public protocol JournalPort:Sendable { func load()throws->OperationJournal?;func archiveExisting(_ journal:OperationJournal)throws;func save(_ journal:OperationJournal)throws;func remove()throws }
public extension JournalPort { func archiveExisting(_ journal:OperationJournal)throws{} }

public final class FileOperationJournal:JournalPort,@unchecked Sendable {
    private let url:URL
    public init(url:URL){self.url=url}
    public func load()throws->OperationJournal?{guard FileManager.default.fileExists(atPath:url.path) else{return nil};let value=try JSONDecoder().decode(OperationJournal.self,from:Data(contentsOf:url));guard value.schemaVersion==OperationJournal.schemaVersion else{throw CocoaError(.coderReadCorrupt)};return value}
    public func archiveExisting(_ journal:OperationJournal)throws{
        guard FileManager.default.fileExists(atPath:url.path) else{return};let archived=url.deletingLastPathComponent().appendingPathComponent("operation-\(journal.operationID.uuidString).interrupted.json")
        guard renameatx_np(AT_FDCWD,url.path,AT_FDCWD,archived.path,UInt32(RENAME_EXCL))==0 else{throw FileSystemError.io("Could not retain interrupted journal evidence: \(String(cString:strerror(errno)))")};try syncDirectory(url.deletingLastPathComponent())
    }
    public func save(_ journal:OperationJournal)throws{
        let directory=url.deletingLastPathComponent();try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]);let data=try JSONEncoder().encode(journal),temporary=directory.appendingPathComponent(".operation-\(journal.operationID.uuidString)-\(UUID().uuidString).tmp")
        let fd=open(temporary.path,O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC,S_IRUSR|S_IWUSR);guard fd>=0 else{throw FileSystemError.io(String(cString:strerror(errno)))}
        do{try data.withUnsafeBytes{bytes in var offset=0;while offset<bytes.count{let count=write(fd,bytes.baseAddress!.advanced(by:offset),bytes.count-offset);guard count>0 else{throw FileSystemError.io(String(cString:strerror(errno)))};offset += count}};guard fsync(fd)==0 else{throw FileSystemError.io(String(cString:strerror(errno)))};close(fd)
            guard rename(temporary.path,url.path)==0 else{throw FileSystemError.io(String(cString:strerror(errno)))};try syncDirectory(directory)
        }catch{close(fd);throw error}
    }
    public func remove()throws{if FileManager.default.fileExists(atPath:url.path){guard unlink(url.path)==0 else{throw FileSystemError.io(String(cString:strerror(errno)))};try syncDirectory(url.deletingLastPathComponent())}}
    private func syncDirectory(_ directory:URL)throws{let fd=open(directory.path,O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);guard fd>=0 else{throw FileSystemError.io(String(cString:strerror(errno)))};defer{close(fd)};guard fsync(fd)==0 else{throw FileSystemError.io(String(cString:strerror(errno)))}}
}
