import AppKit
import RelayKit
import RelayTestSupport
import RelayUI
import SwiftUI
import Testing

/// Renders each card case with `ImageRenderer` at scale 2, in light and dark, and writes
/// `<case>-light.png` and `<case>-dark.png` to `RELAY_SCREENSHOT_DIR` when it is set (design.md
/// decision 14).
@MainActor
struct ScreenshotTests {
    enum Size {
        case tiny, expanded

        var width: CGFloat { self == .tiny ? TinyCard.width : ExpandedCard.width }
        var radius: CGFloat { self == .tiny ? 11 : 16 }
    }

    init() {
        FontLoader.register(directory: FontAndThemeTests.macFolder.appendingPathComponent("Resources/Fonts"))
    }

    static var everyAction: CardActions {
        var actions = CardActions()
        actions.viewCheckpoint = {}
        actions.switchWorker = {}
        return actions
    }

    @Test func tinyHandoff() throws {
        try render("tiny-handoff", .tiny, Sample.card(Sample.handoff()))
    }

    @Test func expandedHandoff() throws {
        try render("expanded-handoff", .expanded, Sample.card(Sample.handoff()))
    }

    @Test func expandedLimitNoWorker() throws {
        let input = try Sample.input(
            jobs: [Sample.jobJSON(current: nil, updatedAt: "2026-10-07T14:20:00.000Z")],
            workers: [Sample.workerJSON(
                id: "a17c9e42", target: "claude:work", state: "ended", fromHandoff: false,
                startedAt: "2026-10-07T12:10:40.000Z", endedAt: "2026-10-07T14:19:30.000Z", endReason: "interrupted", exitCode: 130
            )],
            accounts: [Sample.accountJSON(target: "claude:work", status: "rate_limited", retryAt: "2026-10-07T18:00:00.000Z")]
        )
        try render("expanded-limit-no-worker", .expanded, Sample.card(input))
    }

    @Test func expandedUsage() throws {
        let worker = Sample.workerJSON(id: "c4e81b07", target: "claude:home", fromHandoff: false, startedAt: "2026-10-07T13:05:00.000Z")
        let input = try Sample.input(
            jobs: [Sample.jobJSON(title: "Fix flaky upload tests", current: worker, checkpoint: nil)],
            workers: [worker],
            accounts: [Sample.accountJSON(target: "claude:home", measuredAt: "2026-10-07T14:30:02.000Z", usage: [
                Sample.usageJSON(percent: 41), Sample.usageJSON(percent: 12, minutes: 10080, window: "seven_day"),
            ])],
            host: "Ghostty"
        )
        try render("expanded-usage", .expanded, Sample.card(input))
    }

    @Test func tinyNotRunning() throws {
        try render("tiny-not-running", .tiny, Sample.card(Sample.input(connection: .notRunning, jobs: [])))
    }

    @Test func expandedNoJobs() throws {
        try render("expanded-no-jobs", .expanded, Sample.card(Sample.input(jobs: [])))
    }

    private func render(_ name: String, _ size: Size, _ model: CardModel) throws {
        for scheme in [ColorScheme.light, .dark] {
            let card = Group {
                switch size {
                case .tiny: TinyCard(model: model, actions: Self.everyAction)
                case .expanded: ExpandedCard(model: model, actions: Self.everyAction)
                }
            }
            let palette = Theme.color(.rule, scheme)
            let framed = card
                .clipShape(RoundedRectangle(cornerRadius: size.radius))
                .overlay(RoundedRectangle(cornerRadius: size.radius).strokeBorder(palette, lineWidth: 1))
                .environment(\.colorScheme, scheme)
            let renderer = ImageRenderer(content: framed)
            renderer.scale = 2
            let image = try #require(renderer.cgImage, "\(name) did not render")
            #expect(image.width == Int(size.width * 2), "\(name) is \(image.width) pixels wide")
            #expect(try colorCount(image) > 1, "\(name) is a single color")
            let background = try edgeColor(image)
            let surface = Theme.hex(.surface, scheme)
            #expect([16, 8, 0].allSatisfy { abs(Int((background >> $0) & 0xFF) - Int((surface >> $0) & 0xFF)) <= 2 },
                    "\(name) background is \(String(background, radix: 16))")
            guard let folder = ProcessInfo.processInfo.environment["RELAY_SCREENSHOT_DIR"] else { continue }
            try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
            let png = try #require(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]))
            let file = "\(name)-\(scheme == .dark ? "dark" : "light").png"
            try png.write(to: URL(fileURLWithPath: folder).appendingPathComponent(file))
        }
    }

    /// The image's pixels as RGBA bytes.
    private func pixels(_ image: CGImage) throws -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
                bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            return true
        }
        try #require(drawn)
        return bytes
    }

    private func colorCount(_ image: CGImage) throws -> Int {
        let bytes = try pixels(image)
        var colors = Set<UInt32>()
        for index in stride(from: 0, to: bytes.count, by: 4 * 7) {
            colors.insert(UInt32(bytes[index]) << 16 | UInt32(bytes[index + 1]) << 8 | UInt32(bytes[index + 2]))
            if colors.count > 1 { break }
        }
        return colors.count
    }

    /// The color 6 pixels in from the left edge, half way down: the card's background.
    private func edgeColor(_ image: CGImage) throws -> UInt32 {
        let bytes = try pixels(image)
        let index = ((image.height / 2) * image.width + 6) * 4
        return UInt32(bytes[index]) << 16 | UInt32(bytes[index + 1]) << 8 | UInt32(bytes[index + 2])
    }
}
