// Reuse Tessera's existing artwork, flatten alpha and generate native icon sizes.
// Run: swift apple/generate-icons.swift
import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

let apple = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let assets = apple.appendingPathComponent("Tessera/Assets.xcassets")
let destination = assets.appendingPathComponent("AppIcon.appiconset")
let source = apple.appendingPathComponent("../web/assets/tessera-app-icon-512.png").standardizedFileURL
guard let image = NSImage(contentsOf: source) else { fatalError("Missing Tessera icon artwork") }
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)

func writeIcon(_ size: Int, _ name: String) throws {
    guard let source = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
          let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { fatalError("Icon bitmap allocation failed") }
    context.interpolationQuality = .high
    context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: size, height: size))
    context.draw(source, in: CGRect(x: 0, y: 0, width: size, height: size))
    guard let rendered = context.makeImage(), let output = CGImageDestinationCreateWithURL(destination.appendingPathComponent(name) as CFURL, UTType.png.identifier as CFString, 1, nil) else { fatalError("Icon PNG encoding failed") }
    CGImageDestinationAddImage(output, rendered, nil)
    guard CGImageDestinationFinalize(output) else { fatalError("Icon PNG write failed") }
}

var images: [[String: String]] = [["idiom": "universal", "platform": "ios", "size": "1024x1024", "filename": "AppIcon-iOS.png"]]
try writeIcon(1024, "AppIcon-iOS.png")
for base in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let name = "AppIcon-mac-\(base)@\(scale)x.png"
        try writeIcon(base * scale, name)
        images.append(["idiom": "mac", "size": "\(base)x\(base)", "scale": "\(scale)x", "filename": name])
    }
}
let info: [String: Any] = ["info": ["author": "xcode", "version": 1]]
try JSONSerialization.data(withJSONObject: info, options: [.prettyPrinted, .sortedKeys]).write(to: assets.appendingPathComponent("Contents.json"))
try JSONSerialization.data(withJSONObject: ["images": images, "info": ["author": "xcode", "version": 1]], options: [.prettyPrinted, .sortedKeys]).write(to: destination.appendingPathComponent("Contents.json"))
print("Generated iPad and Mac icons from existing Tessera artwork: \(destination.path)")
