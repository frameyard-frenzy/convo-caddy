import Darwin
import Foundation

public struct PathGuard: Sendable {
    public let home: URL
    public init(home: URL) { self.home = home.standardizedFileURL }
    public func requireSafeDeletionRoot(_ url: URL) throws {
        let candidate=url.standardizedFileURL, forbidden=[URL(fileURLWithPath:"/"),home,home.appendingPathComponent("Library")]
        guard !forbidden.contains(candidate),candidate.path.hasPrefix(home.path+"/") else { throw InventoryError.unsafePath(candidate.path) }
        try rejectUserSymlinkAncestors(candidate)
    }
    public func requireSafeWorkspace(_ url: URL) throws {
        let candidate=url.standardizedFileURL
        guard candidate.path != "/",candidate != home,candidate != home.appendingPathComponent("Library") else { throw InventoryError.unsafePath(candidate.path) }
        try rejectUserSymlinkAncestors(candidate)
    }
    public func requireSafeRecursiveWorkspace(_ url:URL)throws {
        try requireSafeWorkspace(url)
        let candidate=url.standardizedFileURL.path.lowercased(), h=home.standardizedFileURL.path.lowercased()
        let shared=["documents","downloads","desktop","pictures","movies","music","public","applications","library","library/application support","library/caches","library/logs","library/containers","library/group containers","library/cloudstorage"]
        let system=["/applications","/library","/system","/users","/users/shared","/volumes","/private","/usr","/bin","/sbin","/opt"]
        let control=h+"/library/application support/convo caddy control"
        guard !shared.contains(where:{candidate==h+"/"+$0}),!system.contains(candidate),
              candidate != control,!control.hasPrefix(candidate+"/"),!candidate.hasPrefix(control+"/") else {
            throw InventoryError.unsafePath("Shared/system parents and lifecycle control metadata cannot be recursively removed.")
        }
    }
    public func requireAllowedApplication(_ url: URL) throws {
        let candidate=url.standardizedFileURL, allowed=[URL(fileURLWithPath:"/Applications"),home.appendingPathComponent("Applications")]
        guard allowed.contains(where:{candidate.deletingLastPathComponent()==$0}) else { throw InventoryError.unsafePath(candidate.path) }
        try rejectUserSymlinkAncestors(candidate)
    }
    private func rejectUserSymlinkAncestors(_ url:URL)throws{
        var current=url
        while current.path != "/" { var info=stat();if lstat(current.path,&info)==0,(info.st_mode&S_IFMT)==S_IFLNK,info.st_uid != 0 { throw InventoryError.unsafePath("symlink ancestor: \(current.path)") };current.deleteLastPathComponent() }
    }
}

// Every component is opened relative to the preceding pinned descriptor. Never
// resolve user symlinks with realpath: that would turn an alias into authority.
func openNoFollowPath(_ url: URL, directory: Bool) throws -> Int32 {
    guard url.isFileURL, url.path.hasPrefix("/") else { throw FileSystemError.symlink }
    // Foundation canonicalizes /private/var to /var. Expand only this fixed
    // system alias, never an arbitrary caller-controlled symlink.
    let path = url.path == "/var" || url.path.hasPrefix("/var/") ? "/private" + url.path : url.path
    let components = URL(fileURLWithPath:path).pathComponents.filter { $0 != "/" }
    guard !components.contains(".."), !components.contains(".") else { throw FileSystemError.symlink }
    var current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard current >= 0 else { throw FileSystemError.permissionDenied }
    do {
        for (index, component) in components.enumerated() {
            let flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK
                | ((index < components.count - 1 || directory) ? O_DIRECTORY : 0)
            let next = openat(current, component, flags)
            guard next >= 0 else { throw FileSystemError.io("No-follow traversal failed: \(component)") }
            close(current)
            current = next
        }
        return current
    } catch {
        close(current)
        throw error
    }
}

public enum DeletionBoundary: Sendable { case rootOpened,beforeRootUnlink,entryOpened(String),beforeEntryUnlink(String) }
public protocol FileSystemPort: Sendable { func identity(_ url:URL)throws->FileIdentity;func removeTree(_ url:URL,expected:FileIdentity)throws;func exists(_ url:URL)->Bool }
public enum FileSystemError:Error,Equatable { case identityChanged,symlink,mountChanged,permissionDenied,io(String) }

public struct DescriptorFileSystem:FileSystemPort,Sendable {
    private let boundary:@Sendable(DeletionBoundary)throws->Void
    public init(boundary:@escaping @Sendable(DeletionBoundary)throws->Void={_ in}){self.boundary=boundary}
    public func exists(_ url:URL)->Bool{var value=stat();return lstat(url.path,&value)==0}
    public func identity(_ url:URL)throws->FileIdentity{let fd=try openPinned(url);defer{close(fd)};return try identity(fd)}
    public func removeTree(_ url:URL,expected:FileIdentity)throws{
        let parentFD=try openNoFollowPath(url.deletingLastPathComponent(),directory:true)
        defer{close(parentFD)}
        let name=url.lastPathComponent,fd=try openEntry(parentFD,name);defer{close(fd)}
        guard try identity(fd)==expected else{throw FileSystemError.identityChanged}
        try boundary(.rootOpened);try removeOpened(fd:fd,device:expected.device,relative:"");try boundary(.beforeRootUnlink)
        guard try entryIdentity(parentFD,name)==expected else{throw FileSystemError.identityChanged}
        let flags=(try statOf(fd).st_mode&S_IFMT)==S_IFDIR ? AT_REMOVEDIR:0
        guard unlinkat(parentFD,name,flags)==0 else{throw mapErrno()}
    }
    private func removeOpened(fd:Int32,device:UInt64,relative:String)throws{
        let info=try statOf(fd);guard UInt64(info.st_dev)==device else{throw FileSystemError.mountChanged};guard(info.st_mode&S_IFMT)==S_IFDIR else{return}
        let scanFD=dup(fd);guard scanFD>=0,let directory=fdopendir(scanFD) else{if scanFD>=0{close(scanFD)};throw mapErrno()};defer{closedir(directory)};errno=0
        while true{
            errno=0;guard let entry=readdir(directory) else{if errno != 0{throw mapErrno()};break}
            let name=withUnsafePointer(to:&entry.pointee.d_name){$0.withMemoryRebound(to:CChar.self,capacity:Int(MAXNAMLEN)+1){String(cString:$0)}};if name=="."||name==".."{continue}
            let childRelative=relative.isEmpty ? name:"\(relative)/\(name)";var childInfo=stat();guard fstatat(fd,name,&childInfo,AT_SYMLINK_NOFOLLOW)==0 else{throw mapErrno()};guard UInt64(childInfo.st_dev)==device else{throw FileSystemError.mountChanged}
            if(childInfo.st_mode&S_IFMT)==S_IFDIR{
                let child=try openEntry(fd,name);defer{close(child)};let opened=try statOf(child);guard opened.st_dev==childInfo.st_dev,opened.st_ino==childInfo.st_ino else{throw FileSystemError.identityChanged}
                try boundary(.entryOpened(childRelative));try removeOpened(fd:child,device:device,relative:childRelative);try boundary(.beforeEntryUnlink(childRelative))
                guard try entryIdentity(fd,name)==FileIdentity(device:UInt64(opened.st_dev),inode:UInt64(opened.st_ino)) else{throw FileSystemError.identityChanged};guard unlinkat(fd,name,AT_REMOVEDIR)==0 else{throw mapErrno()}
            }else{
                try boundary(.beforeEntryUnlink(childRelative));var current=stat();guard fstatat(fd,name,&current,AT_SYMLINK_NOFOLLOW)==0,current.st_dev==childInfo.st_dev,current.st_ino==childInfo.st_ino else{throw FileSystemError.identityChanged};guard unlinkat(fd,name,0)==0 else{throw mapErrno()}
            }
        }
    }
    private func openPinned(_ url:URL)throws->Int32{try openNoFollowPath(url,directory:false)}
    private func openEntry(_ parent:Int32,_ name:String)throws->Int32{let fd=openat(parent,name,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);guard fd>=0 else{throw mapErrno()};return fd}
    private func statOf(_ fd:Int32)throws->stat{var value=stat();guard fstat(fd,&value)==0 else{throw mapErrno()};guard value.st_uid==getuid() else{throw FileSystemError.permissionDenied};return value}
    private func identity(_ fd:Int32)throws->FileIdentity{let value=try statOf(fd);return .init(device:UInt64(value.st_dev),inode:UInt64(value.st_ino))}
    private func entryIdentity(_ parent:Int32,_ name:String)throws->FileIdentity{var value=stat();guard fstatat(parent,name,&value,AT_SYMLINK_NOFOLLOW)==0 else{throw mapErrno()};return .init(device:UInt64(value.st_dev),inode:UInt64(value.st_ino))}
    private func mapErrno()->FileSystemError{errno==EACCES||errno==EPERM ? .permissionDenied:(errno==ELOOP ? .symlink:.io(String(cString:strerror(errno))))}
}

// Compare existing directory identities while walking ancestry. This recognizes
// case aliases on insensitive volumes without merging distinct case-sensitive paths.
// Lexical containment also covers a not-yet-created preservation destination.
public func workspacePathContains(_ ancestor: URL, _ descendant: URL) -> Bool {
    let a=ancestor.standardizedFileURL, d=descendant.standardizedFileURL
    if d.path == a.path || d.path.hasPrefix(a.path + "/") { return true }
    func identity(_ url: URL) -> FileIdentity? {
        guard let fd=try? openNoFollowPath(url,directory:false) else { return nil }
        defer { close(fd) };var info=stat();guard fstat(fd,&info)==0 else{return nil}
        return FileIdentity(device:UInt64(info.st_dev),inode:UInt64(info.st_ino))
    }
    guard let expected=identity(a) else{return false}
    var current=d
    while true {
        if identity(current) == expected { return true }
        if current.path == "/" { return false }
        current.deleteLastPathComponent()
    }
}
