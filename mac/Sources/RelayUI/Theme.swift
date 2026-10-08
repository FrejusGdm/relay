import SwiftUI

/// The color tokens of `DESIGN.md` ("Color"), plus `--on-accent` from `docs/design/preview.html`
/// with the olive accent.
public enum ThemeToken: String, CaseIterable, Sendable {
    case bg
    case surface
    case raised
    case rule
    case muted
    case ink
    case accent
    case accentSoft = "accent-soft"
    case warning
    case error
    case success
    case onAccent = "on-accent"
}

public enum Theme {
    /// The token's value as `0xRRGGBB`.
    public static func hex(_ token: ThemeToken, _ scheme: ColorScheme) -> UInt32 {
        let pair: (light: UInt32, dark: UInt32) = switch token {
        case .bg: (0xF4F2EC, 0x0D0D0C)
        case .surface: (0xFBFAF7, 0x161614)
        case .raised: (0xFFFFFF, 0x1E1E1B)
        case .rule: (0xD8D5CC, 0x2B2A27)
        case .muted: (0x6E6B63, 0x8A877F)
        case .ink: (0x141413, 0xEDEBE4)
        case .accent: (0x52613A, 0xBDCDA0)
        case .accentSoft: (0xE6EADC, 0x2A3122)
        case .warning: (0x855313, 0xE2BD7C)
        case .error: (0xB3261E, 0xE0574F)
        case .success: (0x426044, 0xAFC79E)
        case .onAccent: (0xFBFAF7, 0x0D0D0C)
        }
        return scheme == .dark ? pair.dark : pair.light
    }

    public static func color(_ token: ThemeToken, _ scheme: ColorScheme) -> Color {
        let value = hex(token, scheme)
        return Color(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255,
            opacity: 1
        )
    }
}
