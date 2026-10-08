import SwiftUI

/// The motion of `DESIGN.md`: one ease-out curve, 180 ms to expand, 120 ms for status text and
/// 100 ms for a press. With "Reduce motion" on, every change is instant.
public enum CardMotion {
    public static func expand(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .timingCurve(0.22, 1, 0.36, 1, duration: 0.18)
    }

    static func text(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .timingCurve(0.22, 1, 0.36, 1, duration: 0.12)
    }

    static func press(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .timingCurve(0.22, 1, 0.36, 1, duration: 0.1)
    }

    /// Opacity and a small offset only.
    static let transition = AnyTransition.opacity.combined(with: .offset(y: -4))
}

/// A plain button that moves down 1 point while pressed.
struct PressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Pressed(configuration: configuration)
    }

    private struct Pressed: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            configuration.label
                .offset(y: configuration.isPressed ? 1 : 0)
                .animation(CardMotion.press(reduceMotion: reduceMotion), value: configuration.isPressed)
        }
    }
}
