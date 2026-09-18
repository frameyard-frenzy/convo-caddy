import CryptoKit
import Darwin
import Foundation

public struct PreservationReceipt:Codable,Equatable,Sendable { public let destination:URL;public let digest:String;public let destinationIdentity:FileIdentity }
public struct PreservationPlan:Codable,Equatable,Sendable { public let source:WorkspaceTarget;public let destination:URL;public let stagingName:String;public let destinationParentIdentity:FileIdentity;public var stagingIdentity:FileIdentity? = nil }
public enum PreservationError:Error,Equatable { case destinationExists,destinationUnsafe,sourceChanged,verificationFailed,interrupted,durabilityFailed,enumerationFailed }
public enum PreservationBoundary:Sendable { case beforeCopy,afterCopy,beforeSync,afterSync,beforePublish,afterPublish }
public enum PreservationIOOperation:Sendable,Equatable { case destinationVolumeOpen,dataWrite(path:String,offset:Int) }
public protocol WorkspacePreserving:Sendable {
    func prepare(source:WorkspaceTarget,destination:URL,operationID:UUID)throws->PreservationPlan
    func execute(_ plan:PreservationPlan)throws->PreservationReceipt
    func execute(_ plan:PreservationPlan, staged:(PreservationPlan)throws->Void)throws->PreservationReceipt
    func verify(_ receipt:PreservationReceipt)throws
}
public extension WorkspacePreserving {
    func execute(_ plan:PreservationPlan, staged:(PreservationPlan)throws->Void)throws->PreservationReceipt { try execute(plan) }
    func preserve(source:WorkspaceTarget,destination:URL)throws->PreservationReceipt{try execute(prepare(source:source,destination:destination,operationID:UUID()))}
}

private enum ManifestKind:String,Codable { case directory,file,symlink }
private struct ManifestEntry:Codable,Equatable { let path:String;let kind:ManifestKind;let mode:UInt16;let size:UInt64;let modifiedSeconds:Int64;let modifiedNanoseconds:Int64;let payload:String }

public struct WorkspacePreserver:WorkspacePreserving,Sendable {
    private let boundary:@Sendable(PreservationBoundary)throws->Void
    private let synchronize:@Sendable(Int32)->Int32
    private let ioFailure:@Sendable(PreservationIOOperation)->Int32?
    public init(boundary:@escaping @Sendable(PreservationBoundary)throws->Void={_ in},ioFailure:@escaping @Sendable(PreservationIOOperation)->Int32?={_ in nil}){self.boundary=boundary;self.synchronize={fsync($0)};self.ioFailure=ioFailure}
    public init(synchronize:@escaping @Sendable(Int32)->Int32){self.boundary={_ in};self.synchronize=synchronize;self.ioFailure={_ in nil}}
    public func prepare(source:WorkspaceTarget,destination:URL,operationID:UUID)throws->PreservationPlan{
        guard !destination.standardizedFileURL.path.hasPrefix(source.url.standardizedFileURL.path+"/") else{throw PreservationError.destinationUnsafe}
        let fs=DescriptorFileSystem();guard try fs.identity(source.url)==source.identity else{throw PreservationError.sourceChanged}
        _ = try treeDigest(source.url) // Reject unsupported content before staging.
        let parent=destination.deletingLastPathComponent();try FileManager.default.createDirectory(at:parent,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let parentIdentity=try fs.identity(parent);let parentFD=try openDirectory(parent);defer{close(parentFD)}
        var info=stat();guard fstatat(parentFD,destination.lastPathComponent,&info,AT_SYMLINK_NOFOLLOW) != 0,errno==ENOENT else{throw PreservationError.destinationExists}
        return .init(source:source,destination:destination,stagingName:".convo-caddy-preserve-\(operationID.uuidString)",destinationParentIdentity:parentIdentity)
    }
    public func execute(_ plan:PreservationPlan)throws->PreservationReceipt { try execute(plan, staged: { _ in }) }
    public func execute(_ initial:PreservationPlan, staged:(PreservationPlan)throws->Void)throws->PreservationReceipt{
        var plan = initial
        if let failure=ioFailure(.destinationVolumeOpen){throw posixError(failure)}
        let parent=plan.destination.deletingLastPathComponent(),parentFD=try openDirectory(parent);defer{close(parentFD)}
        guard try fdIdentity(parentFD)==plan.destinationParentIdentity else{throw PreservationError.destinationUnsafe}
        let sourceFD=try openDirectory(plan.source.url);defer{close(sourceFD)};guard try fdIdentity(sourceFD)==plan.source.identity else{throw PreservationError.sourceChanged}
        var destinationInfo=stat()
        if fstatat(parentFD,plan.destination.lastPathComponent,&destinationInfo,AT_SYMLINK_NOFOLLOW)==0 {
            guard let pinned=plan.stagingIdentity, pinned == FileIdentity(device:UInt64(destinationInfo.st_dev),inode:UInt64(destinationInfo.st_ino)) else{throw PreservationError.destinationExists}
            let published=try openDirectoryAt(parentFD,plan.destination.lastPathComponent);defer{close(published)}
            let expected=digest(try manifest(fd:sourceFD,path:""))
            guard try fdIdentity(published)==pinned,digest(try manifest(fd:published,path:""))==expected,fsync(published)==0,fsync(parentFD)==0 else{throw PreservationError.verificationFailed}
            return .init(destination:plan.destination,digest:expected,destinationIdentity:pinned)
        }
        guard errno==ENOENT else{throw PreservationError.destinationUnsafe}
        let stageFD:Int32
        if let pinned=plan.stagingIdentity {
            stageFD=try openDirectoryAt(parentFD,plan.stagingName)
            guard try fdIdentity(stageFD)==pinned else{close(stageFD);throw PreservationError.destinationUnsafe}
        } else {
            guard mkdirat(parentFD,plan.stagingName,S_IRWXU)==0 else{throw PreservationError.interrupted}
            stageFD=try openDirectoryAt(parentFD,plan.stagingName)
            plan.stagingIdentity=try fdIdentity(stageFD)
            do{guard fsync(parentFD)==0 else{throw PreservationError.durabilityFailed};try staged(plan)}catch{close(stageFD);throw error}
        }
        defer{close(stageFD)}
        do{
            try boundary(.beforeCopy);if try initial.stagingIdentity == nil || manifest(fd:stageFD,path:"").count == 1 { try copyDirectory(sourceFD:sourceFD,destinationFD:stageFD,device:plan.source.identity.device,path:"",synchronize:synchronize,ioFailure:ioFailure) };let sourceRoot=try fdStat(sourceFD);guard fchmod(stageFD,mode_t(sourceRoot.st_mode&0o7777))==0 else{throw PreservationError.durabilityFailed};try setTimes(stageFD,from:sourceRoot);try boundary(.afterCopy)
            let sourceManifest=try manifest(fd:sourceFD,path:""),copyManifest=try manifest(fd:stageFD,path:"");guard sourceManifest==copyManifest else{throw PreservationError.verificationFailed}
            guard try fdIdentity(sourceFD)==plan.source.identity else{throw PreservationError.sourceChanged}
            try boundary(.beforeSync);try synchronizeTree(stageFD,synchronize:synchronize);guard fsync(parentFD)==0 else{throw PreservationError.durabilityFailed};try boundary(.afterSync)
            try boundary(.beforePublish)
            var stagedInfo=stat()
            guard fstatat(parentFD,plan.stagingName,&stagedInfo,AT_SYMLINK_NOFOLLOW)==0,
                  FileIdentity(device:UInt64(stagedInfo.st_dev),inode:UInt64(stagedInfo.st_ino)) == plan.stagingIdentity,
                  try fdIdentity(stageFD)==plan.stagingIdentity else{throw PreservationError.destinationUnsafe}
            guard renameatx_np(parentFD,plan.stagingName,parentFD,plan.destination.lastPathComponent,UInt32(RENAME_EXCL))==0 else{throw errno==EEXIST ? PreservationError.destinationExists:posixError()}
            guard fsync(parentFD)==0 else{throw PreservationError.durabilityFailed};try boundary(.afterPublish)
            let destinationFD=try openDirectoryAt(parentFD,plan.destination.lastPathComponent);defer{close(destinationFD)};let destinationIdentity=try fdIdentity(destinationFD),manifestDigest=digest(sourceManifest)
            guard destinationIdentity==plan.stagingIdentity, digest(try manifest(fd:destinationFD,path:""))==manifestDigest else{throw PreservationError.verificationFailed}
            return .init(destination:plan.destination,digest:manifestDigest,destinationIdentity:destinationIdentity)
        }catch{throw error}
    }
    public func verify(_ receipt:PreservationReceipt)throws{
        let fd=try openDirectory(receipt.destination);defer{close(fd)};guard try fdIdentity(fd)==receipt.destinationIdentity,digest(try manifest(fd:fd,path:""))==receipt.digest else{throw PreservationError.verificationFailed}
    }
}

public func treeDigest(_ root:URL)throws->String{let fd=try openDirectory(root);defer{close(fd)};return digest(try manifest(fd:fd,path:""))}
private func manifest(fd:Int32,path:String)throws->[ManifestEntry]{
    let root=try fdStat(fd);try requireNoResourceFork(fd);guard(root.st_mode&S_IFMT)==S_IFDIR else{throw PreservationError.verificationFailed}
    var result=[ManifestEntry(path:path,kind:.directory,mode:UInt16(root.st_mode&0o7777),size:0,modifiedSeconds:Int64(root.st_mtimespec.tv_sec),modifiedNanoseconds:Int64(root.st_mtimespec.tv_nsec),payload:"")]
    let scanFD=openat(fd,".",O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);guard scanFD>=0,let directory=fdopendir(scanFD) else{if scanFD>=0{close(scanFD)};throw PreservationError.enumerationFailed};defer{closedir(directory)}
    var names:[String]=[]
    while true{errno=0;guard let entry=readdir(directory) else{if errno != 0{throw PreservationError.enumerationFailed};break};let name=withUnsafePointer(to:&entry.pointee.d_name){$0.withMemoryRebound(to:CChar.self,capacity:Int(MAXNAMLEN)+1){String(cString:$0)}};if name != "."&&name != ".."{names.append(name)}}
    for name in names.sorted(){
        let relative=path.isEmpty ? name:"\(path)/\(name)";var info=stat();guard fstatat(fd,name,&info,AT_SYMLINK_NOFOLLOW)==0,info.st_uid==getuid() else{throw PreservationError.enumerationFailed}
        switch info.st_mode&S_IFMT{
        case S_IFDIR:
            let child=try openDirectoryAt(fd,name);defer{close(child)};let opened=try fdStat(child);guard opened.st_dev==info.st_dev,opened.st_ino==info.st_ino else{throw PreservationError.sourceChanged};result += try manifest(fd:child,path:relative)
        case S_IFREG:
            let child=openat(fd,name,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);guard child>=0 else{throw PreservationError.enumerationFailed};defer{close(child)};let opened=try fdStat(child);guard opened.st_dev==info.st_dev,opened.st_ino==info.st_ino else{throw PreservationError.sourceChanged};try requireNoResourceFork(child);let data=try readAll(child);let final=try fdStat(child);guard final.st_size==opened.st_size,final.st_mtimespec.tv_sec==opened.st_mtimespec.tv_sec,final.st_mtimespec.tv_nsec==opened.st_mtimespec.tv_nsec else{throw PreservationError.sourceChanged};result.append(.init(path:relative,kind:.file,mode:UInt16(opened.st_mode&0o7777),size:UInt64(data.count),modifiedSeconds:Int64(opened.st_mtimespec.tv_sec),modifiedNanoseconds:Int64(opened.st_mtimespec.tv_nsec),payload:SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined()))
        case S_IFLNK:
            var bytes=[CChar](repeating:0,count:Int(PATH_MAX));let count=readlinkat(fd,name,&bytes,bytes.count);guard count>=0 else{throw PreservationError.enumerationFailed};result.append(.init(path:relative,kind:.symlink,mode:UInt16(info.st_mode&0o7777),size:UInt64(count),modifiedSeconds:Int64(info.st_mtimespec.tv_sec),modifiedNanoseconds:Int64(info.st_mtimespec.tv_nsec),payload:String(decoding:bytes.prefix(Int(count)).map{UInt8(bitPattern:$0)},as:UTF8.self)))
        default:throw PreservationError.verificationFailed
        }
    };return result
}
// Data-fork-only copying cannot promise preservation of a resource fork.
// Stop before staging/deletion rather than silently discard unsupported content.
private func requireNoResourceFork(_ fd:Int32)throws {
    errno=0
    let size=fgetxattr(fd,"com.apple.ResourceFork",nil,0,0,0)
    guard size == 0 || (size < 0 && errno == ENOATTR) else {
        throw FileSystemError.io("Resource-fork content cannot be preserved by this build. Original data was retained; copy it with Finder and review again.")
    }
}
private func digest(_ entries:[ManifestEntry])->String{var hasher=SHA256();for entry in entries{frame(Data(entry.kind.rawValue.utf8),into:&hasher);frame(Data(entry.path.utf8),into:&hasher);var mode=entry.mode.bigEndian,size=entry.size.bigEndian,seconds=entry.modifiedSeconds.bigEndian,nanoseconds=entry.modifiedNanoseconds.bigEndian;frame(Data(bytes:&mode,count:2),into:&hasher);frame(Data(bytes:&size,count:8),into:&hasher);frame(Data(bytes:&seconds,count:8),into:&hasher);frame(Data(bytes:&nanoseconds,count:8),into:&hasher);frame(Data(entry.payload.utf8),into:&hasher)};return hasher.finalize().map{String(format:"%02x",$0)}.joined()}
private func frame(_ data:Data,into hasher:inout SHA256){var length=UInt64(data.count).bigEndian;hasher.update(data:Data(bytes:&length,count:8));hasher.update(data:data)}
private func copyDirectory(sourceFD:Int32,destinationFD:Int32,device:UInt64,path:String,synchronize:@Sendable(Int32)->Int32,ioFailure:@Sendable(PreservationIOOperation)->Int32?)throws{
    let scanFD=openat(sourceFD,".",O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);guard scanFD>=0,let directory=fdopendir(scanFD) else{if scanFD>=0{close(scanFD)};throw PreservationError.enumerationFailed};defer{closedir(directory)};var names:[String]=[]
    while true{errno=0;guard let entry=readdir(directory) else{if errno != 0{throw PreservationError.enumerationFailed};break};let name=withUnsafePointer(to:&entry.pointee.d_name){$0.withMemoryRebound(to:CChar.self,capacity:Int(MAXNAMLEN)+1){String(cString:$0)}};if name != "."&&name != ".."{names.append(name)}}
    for name in names.sorted(){var info=stat();guard fstatat(sourceFD,name,&info,AT_SYMLINK_NOFOLLOW)==0,UInt64(info.st_dev)==device,info.st_uid==getuid() else{throw PreservationError.sourceChanged}
        switch info.st_mode&S_IFMT{
        case S_IFDIR:
            guard mkdirat(destinationFD,name,mode_t(info.st_mode&0o7777))==0 else{throw posixError()};let source=try openDirectoryAt(sourceFD,name),destination=try openDirectoryAt(destinationFD,name);defer{close(source);close(destination)};let opened=try fdStat(source);guard opened.st_ino==info.st_ino,opened.st_dev==info.st_dev else{throw PreservationError.sourceChanged};try copyDirectory(sourceFD:source,destinationFD:destination,device:device,path:path.isEmpty ? name:path+"/"+name,synchronize:synchronize,ioFailure:ioFailure);guard fchmod(destination,mode_t(info.st_mode&0o7777))==0 else{throw PreservationError.durabilityFailed};try setTimes(destination,from:opened);guard synchronize(destination)==0 else{throw PreservationError.durabilityFailed}
        case S_IFREG:
            let source=openat(sourceFD,name,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);guard source>=0 else{throw PreservationError.enumerationFailed};defer{close(source)};let opened=try fdStat(source);guard opened.st_ino==info.st_ino,opened.st_dev==info.st_dev else{throw PreservationError.sourceChanged};let destination=openat(destinationFD,name,O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC,mode_t(info.st_mode&0o7777));guard destination>=0 else{throw posixError()};defer{close(destination)};try copyBytes(source:source,destination:destination,path:path.isEmpty ? name:path+"/"+name,ioFailure:ioFailure);guard fchmod(destination,mode_t(info.st_mode&0o7777))==0 else{throw PreservationError.durabilityFailed};try setTimes(destination,from:opened);guard synchronize(destination)==0 else{throw PreservationError.durabilityFailed}
        case S_IFLNK:
            var bytes=[CChar](repeating:0,count:Int(PATH_MAX));let count=readlinkat(sourceFD,name,&bytes,bytes.count);guard count>=0 else{throw PreservationError.enumerationFailed};bytes[Int(count)]=0;guard symlinkat(bytes,destinationFD,name)==0 else{throw posixError()};var times=[timespec(tv_sec:info.st_mtimespec.tv_sec,tv_nsec:info.st_mtimespec.tv_nsec),timespec(tv_sec:info.st_mtimespec.tv_sec,tv_nsec:info.st_mtimespec.tv_nsec)];guard utimensat(destinationFD,name,&times,AT_SYMLINK_NOFOLLOW)==0 else{throw PreservationError.durabilityFailed}
        default:throw PreservationError.verificationFailed
        }
    }
}
private func synchronizeTree(_ root:Int32,synchronize:@Sendable(Int32)->Int32)throws {
    let entries=try manifest(fd:root,path:"")
    for entry in entries.filter({$0.kind == .file}) + entries.filter({$0.kind == .directory}).reversed() {
        var fd=dup(root);guard fd>=0 else{throw PreservationError.durabilityFailed}
        do {
            for part in entry.path.split(separator:"/") {
                let next=openat(fd,String(part),O_RDONLY|O_CLOEXEC|O_NOFOLLOW)
                guard next>=0 else{throw PreservationError.durabilityFailed};close(fd);fd=next
            }
            let info=try fdStat(fd)
            guard (info.st_mode&S_IFMT)==(entry.kind == .file ? S_IFREG:S_IFDIR),synchronize(fd)==0 else{throw PreservationError.durabilityFailed}
            close(fd)
        } catch {close(fd);throw error}
    }
}
private func copyBytes(source:Int32,destination:Int32,path:String,ioFailure:@Sendable(PreservationIOOperation)->Int32?)throws{var buffer=[UInt8](repeating:0,count:65536),total=0;while true{let count=read(source,&buffer,buffer.count);if count==0{return};guard count>0 else{throw posixError()};var offset=0;while offset<count{if let failure=ioFailure(.dataWrite(path:path,offset:total+offset)){throw posixError(failure)};let written=buffer.withUnsafeBytes{write(destination,$0.baseAddress!.advanced(by:offset),count-offset)};guard written>0 else{throw posixError()};offset += written};total += count}}
private func readAll(_ fd:Int32)throws->Data{guard lseek(fd,0,SEEK_SET)>=0 else{throw posixError()};var data=Data(),buffer=[UInt8](repeating:0,count:65536);while true{let count=read(fd,&buffer,buffer.count);if count==0{return data};guard count>0 else{throw posixError()};data.append(buffer,count:count)}}
private func openDirectory(_ url:URL)throws->Int32{try openNoFollowPath(url,directory:true)}
private func openDirectoryAt(_ parent:Int32,_ name:String)throws->Int32{let fd=openat(parent,name,O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);guard fd>=0 else{throw posixError()};return fd}
private func fdStat(_ fd:Int32)throws->stat{var value=stat();guard fstat(fd,&value)==0,value.st_uid==getuid() else{throw PreservationError.sourceChanged};return value}
private func fdIdentity(_ fd:Int32)throws->FileIdentity{let value=try fdStat(fd);return .init(device:UInt64(value.st_dev),inode:UInt64(value.st_ino))}
private func setTimes(_ fd:Int32,from info:stat)throws{var times=[timespec(tv_sec:info.st_mtimespec.tv_sec,tv_nsec:info.st_mtimespec.tv_nsec),timespec(tv_sec:info.st_mtimespec.tv_sec,tv_nsec:info.st_mtimespec.tv_nsec)];guard futimens(fd,&times)==0 else{throw PreservationError.durabilityFailed}}
private func posixError()->PreservationError{.interrupted}
private func posixError(_ code:Int32)->PreservationError{code == ENOSPC ? .durabilityFailed:.interrupted}
