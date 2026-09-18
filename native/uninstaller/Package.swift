// swift-tools-version: 6.0
import PackageDescription
import Foundation

let configuredDeveloperRoot = ProcessInfo.processInfo.environment["DEVELOPER_DIR"].map { "\($0)/Library/Developer" }
let developerRoots = [configuredDeveloperRoot].compactMap { $0 } + [
    "/Library/Developer/CommandLineTools/Library/Developer",
    "/Applications/Xcode.app/Contents/Developer/Library/Developer",
]
let developerRoot = developerRoots.first { FileManager.default.fileExists(atPath: "\($0)/Frameworks/Testing.framework") }
let testSwiftSettings: [SwiftSetting] = developerRoot.map { [.unsafeFlags(["-F", "\($0)/Frameworks"])] } ?? []
let testLinkerSettings: [LinkerSetting] = developerRoot.map {
    [.unsafeFlags(["-F", "\($0)/Frameworks", "-Xlinker", "-rpath", "-Xlinker", "\($0)/Frameworks", "-Xlinker", "-rpath", "-Xlinker", "\($0)/usr/lib"])]
} ?? []

let package = Package(
    name: "ConvoCaddyUninstaller",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "UninstallCore", targets: ["UninstallCore"]),
        .executable(name: "UninstallConvoCaddy", targets: ["UninstallApp"]),
    ],
    targets: [
        .target(name: "UninstallCore"),
        .executableTarget(name: "UninstallApp", dependencies: ["UninstallCore"]),
        .testTarget(name: "UninstallCoreTests", dependencies: ["UninstallCore"], swiftSettings: testSwiftSettings, linkerSettings: testLinkerSettings),
    ]
)
