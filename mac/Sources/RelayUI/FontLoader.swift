import CoreText
import Foundation
import os

/// Registers the app's fonts for this process: Public Sans and IBM Plex Mono (design.md decision
/// 13; Satoshi is not shipped). When a font is
/// missing, SwiftUI falls back to the system font and the failure is written to the unified log.
public enum FontLoader {
    public static let postScriptNames = [
        "PublicSans-Regular",
        "PublicSans-Medium",
        "PublicSans-SemiBold",
        "PublicSans-Bold",
        "IBMPlexMono",
        "IBMPlexMono-Medm",
    ]

    /// Registers every `.otf` and `.ttf` file in `directory`. Returns the files that failed.
    @discardableResult
    public static func register(directory: URL) -> [URL] {
        let logger = Logger(subsystem: "io.github.frejusgdm.relay", category: "fonts")
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        let fonts = files.filter { ["otf", "ttf"].contains($0.pathExtension.lowercased()) }
        if fonts.isEmpty {
            logger.error("No font files in \(directory.path, privacy: .public); using the system font.")
        }
        var failed: [URL] = []
        for font in fonts {
            var error: Unmanaged<CFError>?
            if CTFontManagerRegisterFontsForURL(font as CFURL, .process, &error) { continue }
            if let cfError = error?.takeRetainedValue(),
               CFErrorGetCode(cfError) == CTFontManagerError.alreadyRegistered.rawValue {
                continue
            }
            logger.error("Could not load the font \(font.lastPathComponent, privacy: .public); using the system font.")
            failed.append(font)
        }
        return failed
    }
}
