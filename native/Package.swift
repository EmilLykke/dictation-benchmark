// swift-tools-version: 6.0
import PackageDescription

// `FlowBridgeCore` exists so the timing rules can be tested. A SwiftPM executable
// target cannot be imported by a test target, and the two things the benchmark
// contract requires proof of - that a hotkey stamp is taken at the Z key-down edge,
// and that the 750ms stability delay stays out of the response metric - are exactly
// the things that must not need a real Wispr Flow, a real keypress, or real audio to
// check. The executable keeps the AppKit receiver window and the Core Audio work.
let package = Package(
    name: "FlowBridge",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "flow-bridge", targets: ["FlowBridge"]),
    ],
    targets: [
        .target(
            name: "FlowBridgeCore",
            path: "Sources/FlowBridgeCore",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "FlowBridge",
            dependencies: ["FlowBridgeCore"],
            path: "Sources/FlowBridge",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "FlowBridgeCoreTests",
            dependencies: ["FlowBridgeCore"],
            path: "Tests/FlowBridgeCoreTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
