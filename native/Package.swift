// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "FlowBridge",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "flow-bridge", targets: ["FlowBridge"]),
    ],
    targets: [
        .executableTarget(
            name: "FlowBridge",
            path: "Sources/FlowBridge",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)

