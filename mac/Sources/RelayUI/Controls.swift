import SwiftUI

/// The card's primary action: full width, accent background, with the arrow (`.rc-primary`).
struct PrimaryButton: View {
    let label: String
    var isEnabled = true
    /// Whether Return presses this button.
    var isDefault = true
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let palette = Palette(scheme: scheme)
        Button(action: action) {
            HStack(spacing: 10) {
                Text(label)
                    .font(RelayFont.text(13, .semibold))
                RightArrow().line(palette(.onAccent), width: 1.3)
                    .frame(width: 17, height: 17)
            }
            .foregroundStyle(palette(.onAccent))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .padding(.horizontal, 15)
            .background(RoundedRectangle(cornerRadius: 8).fill(palette(.accent)))
            .opacity(isEnabled ? 1 : 0.45)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .disabled(!isEnabled)
        .keyboardShortcut(isDefault ? .defaultAction : nil)
    }
}

/// A quiet button with a border, for "Cancel", "Close" and "Copy" (`.rc-control`).
struct SecondaryButton: View {
    let title: String
    /// Whether Escape presses this button.
    var isCancel = false
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let palette = Palette(scheme: scheme)
        Button(action: action) {
            Text(title)
                .font(RelayFont.text(12, .medium))
                .foregroundStyle(palette(.ink))
                .padding(.vertical, 7)
                .padding(.horizontal, 11)
                .background(RoundedRectangle(cornerRadius: 6).strokeBorder(palette(.rule), lineWidth: 1))
                .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .keyboardShortcut(isCancel ? .cancelAction : nil)
    }
}

/// An underlined text button (`.rc-text-btn`).
struct TextButton: View {
    let title: String
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let palette = Palette(scheme: scheme)
        Button(action: action) {
            Text(title)
                .font(RelayFont.text(12))
                .underline(true, color: palette(.rule))
                .foregroundStyle(palette(.muted))
                .padding(.vertical, 4)
        }
        .buttonStyle(PressStyle())
    }
}
