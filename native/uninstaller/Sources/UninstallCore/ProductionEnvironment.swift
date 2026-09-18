import AppKit
import CryptoKit
import Darwin
import Foundation

public struct RunningCaddyProcesses: ProcessPort, Sendable {
    public init() {}
    public func currentAppProcesses() -> [URL] {
        NSRunningApplication.runningApplications(withBundleIdentifier: caddyBundleIdentifier).compactMap(\.bundleURL)
    }
    public func legacyOrUnknownProcesses() -> [URL] {
        NSWorkspace.shared.runningApplications.compactMap { application in
            guard application.bundleIdentifier != caddyBundleIdentifier,
                  let executable = application.executableURL else { return nil }
            let path = executable.standardizedFileURL.path
            let isKnownExecutable = path.hasSuffix("/Convo Caddy.app/Contents/MacOS/Convo Caddy")
                || path.hasSuffix("/ConvoCaddy.app/Contents/MacOS/ConvoCaddy")
            return isKnownExecutable ? executable : nil
        }
    }
}

public struct ProductionInventory {
    public static func build(home: URL, applicationCandidates: [URL]? = nil) throws -> RemovalInventory {
        let fm = FileManager.default
        let support = home.appendingPathComponent("Library/Application Support/Convo Caddy")
        // Never erase the only reconciliation record for a two-root move.
        if try evidenceBytes(support.appendingPathComponent("config/workspace-move.json")) != nil {
            throw InventoryError.workspaceMovePending
        }
        let preferences = support.appendingPathComponent("config/preferences.json")
        var workspaces: [WorkspaceTarget] = []
        var readable = true
        var evidence: [String: String] = [:]
        do {
            if let data = try evidenceBytes(preferences) {
                evidence[preferences.path] = data.digest
                guard let object = try JSONSerialization.jsonObject(with: data.bytes) as? [String: Any],
                      let version = object["schemaVersion"] as? NSNumber,
                      CFGetTypeID(version) != CFBooleanGetTypeID() else { throw InventoryError.unreadablePreferences }
                // Version 1 did not select a workspace; the app migrates it to nil.
                guard version == 1 || (version == 2 && Set(object.keys) == Set(["schemaVersion", "workspaceRoot"]) &&
                    (object["workspaceRoot"] is NSNull || (object["workspaceRoot"] as? String)?.hasPrefix("/") == true)) else {
                    throw InventoryError.unreadablePreferences
                }
                if version == 2, let path = object["workspaceRoot"] as? String {
                    let url = URL(fileURLWithPath: path)
                    if fm.fileExists(atPath: url.path) {
                        let fs=DescriptorFileSystem()
                        let marker=url.appendingPathComponent(".convo-caddy-workspace.json")
                        if let data=try evidenceBytes(marker) { evidence[marker.path]=data.digest }
                        workspaces.append(WorkspaceTarget(url:url,kind:hasDedicatedOwnership(url) ? .dedicated : .external,identity:try fs.identity(url)))
                    }
                }
            }
        } catch { readable = false }
        let legacy = support.appendingPathComponent("workspace")
        if fm.fileExists(atPath: legacy.path) { workspaces.append(WorkspaceTarget(url:legacy,kind:.legacyNested,identity:try DescriptorFileSystem().identity(legacy))) }
        let privateCandidates = [support,home.appendingPathComponent("Library/Logs/Convo Caddy"),home.appendingPathComponent("Library/Caches/com.frameyard.convocaddy"),home.appendingPathComponent("Library/Preferences/com.frameyard.convocaddy.plist"),home.appendingPathComponent("Library/Saved Application State/com.frameyard.convocaddy.savedState")]
        var applications: [URL] = []
        for url in applicationCandidates ?? [URL(fileURLWithPath:"/Applications/Convo Caddy.app"),home.appendingPathComponent("Applications/Convo Caddy.app")] where fm.fileExists(atPath:url.path) {
            guard let bundle=Bundle(url:url), bundle.bundleIdentifier == caddyBundleIdentifier else { throw InventoryError.wrongBundle(url.path) }
            _ = try DescriptorFileSystem().identity(url)
            applications.append(url)
        }
        // Checkpoints are private app content, not a backup obligation. Bind their
        // bytes to this review; only recognized capture fields inform the user.
        let checkpoints = [support.appendingPathComponent("active-session.json"),
                           legacy.appendingPathComponent("current-session.json"),
                           legacy.appendingPathComponent("active-session.json")]
        var possiblyUnfinishedCapture = false
        for checkpoint in checkpoints {
            if let data = try evidenceBytes(checkpoint) { evidence[checkpoint.path] = data.digest; possiblyUnfinishedCapture = possiblyUnfinishedCapture || mayHaveRemoteCapture(data.bytes) }
        }
        let privateRoots=privateCandidates.filter{fm.fileExists(atPath:$0.path)},fs=DescriptorFileSystem(),confirmed=try Dictionary(uniqueKeysWithValues:(privateRoots+applications).map{($0.standardizedFileURL.path,try fs.identity($0))})
        return RemovalInventory(privateRoots:privateRoots,applicationBundles:applications,workspaces:workspaces,preferencesReadable:readable,possiblyUnfinishedCapture:possiblyUnfinishedCapture,confirmedTargetIdentities:confirmed,evidenceDigests:evidence)
    }

    // FileSessionRepository writes {schemaVersion:1,state,mutations,workspace}
    // even for fresh live_ready state. This narrow hint is not deletion authority
    // or proof that the remote bot is still present. Legacy/malformed bytes alone
    // establish neither a live interview nor a preservation requirement.
    private static func mayHaveRemoteCapture(_ data:Data) -> Bool {
        guard let object=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
              let version=object["schemaVersion"] as? NSNumber,CFGetTypeID(version) != CFBooleanGetTypeID(),version==1,
              object["mutations"] is [Any],object["workspace"] != nil,
              let state=object["state"] as? [String:Any],let capture=state["capture"] as? [String:Any],
              capture["mode"] as? String == "recall",let status=capture["status"] as? String,
              ["joining","waiting_room","in_call","recording","failed"].contains(status),
              let provider=capture["provider"] as? [String:Any],provider["name"] as? String == "recall_ai",
              let botID=provider["botId"] as? String,!botID.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else{return false}
        return true
    }

    public static func hasDedicatedOwnership(_ root: URL) -> Bool {
        guard let data=try? evidenceBytes(root.appendingPathComponent(".convo-caddy-workspace.json")),
              let value=(try? JSONSerialization.jsonObject(with:data.bytes)) as? [String:Any],
              Set(value.keys)==Set(["schemaVersion","application","device","inode"]),
              let version=value["schemaVersion"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version==1,
              value["application"] as? String == caddyBundleIdentifier,
              let identity=try? DescriptorFileSystem().identity(root),
              value["device"] as? String == String(identity.device),value["inode"] as? String == String(identity.inode) else{return false}
        return true
    }

    private static func hash(_ data:Data) -> String { SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined() }
    // Only a proven missing component means absent. Existing symlinks and
    // inaccessible evidence never become permission to forget a workspace.
    static func evidenceBytes(_ url:URL) throws -> (bytes:Data,digest:String)? {
        var current=URL(fileURLWithPath:"/")
        let expanded=url.path.hasPrefix("/var/") ? "/private"+url.path : url.path
        for component in URL(fileURLWithPath:expanded).pathComponents where component != "/" {
            current.appendPathComponent(component)
            var info=stat()
            if lstat(current.path,&info) != 0 { if errno == ENOENT { return nil }; throw InventoryError.unreadablePreferences }
            guard (info.st_mode&S_IFMT) != S_IFLNK else { throw InventoryError.unreadablePreferences }
        }
        let fd=try openNoFollowPath(url,directory:false);defer{close(fd)}
        var before=stat();guard fstat(fd,&before)==0,(before.st_mode&S_IFMT)==S_IFREG,before.st_uid==getuid() else{throw InventoryError.unreadablePreferences}
        var bytes=Data(),buffer=[UInt8](repeating:0,count:65536)
        while true {let count=read(fd,&buffer,buffer.count);if count==0{break};guard count>0 else{throw InventoryError.unreadablePreferences};bytes.append(buffer,count:count)}
        var after=stat();guard fstat(fd,&after)==0,after.st_size==before.st_size,after.st_mtimespec.tv_sec==before.st_mtimespec.tv_sec,after.st_mtimespec.tv_nsec==before.st_mtimespec.tv_nsec else{throw InventoryError.unreadablePreferences}
        // The digest binds identity as well as bytes; replacing evidence with
        // identical contents still requires renewed review.
        return (bytes,hash(Data("\(before.st_dev):\(before.st_ino):".utf8) + bytes))
    }
}
