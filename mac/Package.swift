// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "RelayMac",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Relay", targets: ["Relay"])],
    targets: [
        .target(name: "RelayKit"),
        .target(name: "RelayUI", dependencies: ["RelayKit"]),
        .executableTarget(name: "Relay", dependencies: ["RelayKit", "RelayUI"]),
        .target(name: "RelayTestSupport", dependencies: ["RelayKit"], path: "Tests/Support"),
        .testTarget(name: "RelayKitTests", dependencies: ["RelayKit", "RelayTestSupport"], path: "Tests/RelayKitTests"),
        .testTarget(name: "RelayUITests", dependencies: ["RelayKit", "RelayUI", "RelayTestSupport"], path: "Tests/RelayUITests"),
    ]
)
