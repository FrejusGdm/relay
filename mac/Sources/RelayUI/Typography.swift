import SwiftUI

/// The typefaces of the card: Public Sans for text and, in bold, for the expanded title (in place of
/// Satoshi, which the app does not ship; design.md decision 13), and IBM Plex Mono for hashes, job
/// IDs, paths and commands. A face that did not load falls back to the system font.
enum RelayFont {
    enum Weight {
        case regular, medium, semibold
    }

    static func text(_ size: CGFloat, _ weight: Weight = .regular) -> Font {
        switch weight {
        case .regular: .custom("PublicSans-Regular", size: size)
        case .medium: .custom("PublicSans-Medium", size: size)
        case .semibold: .custom("PublicSans-SemiBold", size: size)
        }
    }

    static func display(_ size: CGFloat) -> Font {
        .custom("PublicSans-Bold", size: size)
    }

    /// The preview sets monospace at 0.94 em of the text around it.
    static func mono(_ size: CGFloat, medium: Bool = false) -> Font {
        .custom(medium ? "IBMPlexMono-Medm" : "IBMPlexMono", size: (size * 0.94).rounded(.toNearestOrEven))
    }
}

/// The colors of the current appearance.
struct Palette {
    let scheme: ColorScheme

    func callAsFunction(_ token: ThemeToken) -> Color {
        Theme.color(token, scheme)
    }
}

extension StyledText {
    /// The runs as one `Text`: `.strong` in the accent color and semibold, `.mono` in IBM Plex
    /// Mono, `.muted` in the muted color.
    func text(size: CGFloat, weight: RelayFont.Weight = .regular, color: Color, palette: Palette) -> Text {
        runs.reduce(Text(verbatim: "")) { result, run in
            let piece = Text(verbatim: run.text)
            switch run.style {
            case .plain:
                return result + piece.font(RelayFont.text(size, weight)).foregroundStyle(color)
            case .strong:
                return result + piece.font(RelayFont.text(size, .semibold)).foregroundStyle(palette(.accent))
            case .mono:
                return result + piece.font(RelayFont.mono(size)).foregroundStyle(color)
            case .muted:
                return result + piece.font(RelayFont.text(size, weight)).foregroundStyle(palette(.muted))
            }
        }
    }
}
