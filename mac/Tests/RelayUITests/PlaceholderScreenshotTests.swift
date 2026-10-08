import AppKit
import SwiftUI
import Testing

/// Writes `placeholder.png` so the workflow's screenshot upload has a file until task 3.3 adds the
/// real cases (and deletes this test).
struct PlaceholderScreenshotTests {
    @MainActor
    @Test func rendersRelayToPNG() throws {
        let renderer = ImageRenderer(content: Text("relay").padding())
        renderer.scale = 2
        let image = try #require(renderer.cgImage)
        #expect(image.width > 0)
        guard let folder = ProcessInfo.processInfo.environment["RELAY_SCREENSHOT_DIR"] else { return }
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        let png = try #require(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: folder).appendingPathComponent("placeholder.png"))
    }
}
