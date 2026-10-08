import AppKit
import Foundation
import RelayUI
import SwiftUI
import Testing

struct FontAndThemeTests {
    static let macFolder = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()

    @Test func everyFontRegistersAndIsFoundByName() throws {
        let fonts = Self.macFolder.appendingPathComponent("Resources/Fonts")
        let files = try FileManager.default.contentsOfDirectory(atPath: fonts.path).filter { $0.hasSuffix(".otf") }
        #expect(files.count == FontLoader.postScriptNames.count, "Run mac/scripts/fetch-fonts.sh first.")
        #expect(FontLoader.register(directory: fonts).isEmpty)
        for name in FontLoader.postScriptNames {
            #expect(NSFont(name: name, size: 13) != nil, "\(name)")
        }
    }

    @Test func everyColorTokenMatchesDesignMD() throws {
        let design = try String(contentsOf: Self.macFolder.deletingLastPathComponent().appendingPathComponent("DESIGN.md"), encoding: .utf8)
        var tokens: [String: (light: UInt32, dark: UInt32)] = [:]
        for line in design.components(separatedBy: "\n") where line.hasPrefix("| `--") {
            let cells = line.split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "`", with: "") }
            guard cells.count >= 3, let light = UInt32(cells[1].dropFirst(), radix: 16), let dark = UInt32(cells[2].dropFirst(), radix: 16) else {
                continue
            }
            tokens[String(cells[0].dropFirst(2))] = (light, dark)
        }
        #expect(tokens.count == 11)
        // --on-accent is not in DESIGN.md; docs/design/preview.html gives it for the olive accent.
        tokens["on-accent"] = (0xFBFAF7, 0x0D0D0C)
        #expect(Set(tokens.keys) == Set(ThemeToken.allCases.map(\.rawValue)))
        for token in ThemeToken.allCases {
            let expected = try #require(tokens[token.rawValue])
            #expect(Theme.hex(token, .light) == expected.light, "\(token.rawValue) light")
            #expect(Theme.hex(token, .dark) == expected.dark, "\(token.rawValue) dark")
            for scheme in [ColorScheme.light, .dark] {
                let color = try #require(NSColor(Theme.color(token, scheme)).usingColorSpace(.sRGB))
                let rgb = (UInt32((color.redComponent * 255).rounded()) << 16)
                    | (UInt32((color.greenComponent * 255).rounded()) << 8)
                    | UInt32((color.blueComponent * 255).rounded())
                #expect(rgb == Theme.hex(token, scheme), "\(token.rawValue) \(scheme)")
            }
        }
    }
}
