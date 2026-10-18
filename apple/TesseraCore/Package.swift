// swift-tools-version: 6.0
import PackageDescription

// Platform-independent pieces of the Tessera app, testable with `swift test`
// without a simulator.
let package = Package(
    name: "TesseraCore",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "TesseraCore", targets: ["TesseraCore"]),
    ],
    targets: [
        .target(name: "TesseraCore"),
        .testTarget(name: "TesseraCoreTests", dependencies: ["TesseraCore"]),
    ]
)
