import RelayKit
import SwiftUI

/// "View checkpoint": the last checkpoint in full (design.md decision 10). It replaces the card in
/// its window until "Close".
public struct CheckpointSheet: View {
    let details: CheckpointDetails
    let copy: @MainActor (String) -> Void
    let close: @MainActor () -> Void
    @Environment(\.colorScheme) private var scheme

    public init(details: CheckpointDetails, copy: @escaping @MainActor (String) -> Void, close: @escaping @MainActor () -> Void) {
        self.details = details
        self.copy = copy
        self.close = close
    }

    public var body: some View {
        let palette = Palette(scheme: scheme)
        SheetFrame(title: details.title) {
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 9, verticalSpacing: 9) {
                row("Commit", palette) {
                    Text(details.commit).font(RelayFont.mono(12)).foregroundStyle(palette(.ink)).textSelection(.enabled)
                }
                row("Saved", palette) {
                    details.saved.rendered(size: 12, color: palette(.ink), palette: palette)
                }
                row("Kind", palette) {
                    Text(details.kind).font(RelayFont.text(12)).foregroundStyle(palette(.ink))
                }
                if let message = details.message {
                    row("Message", palette) {
                        Text(message).font(RelayFont.text(12)).foregroundStyle(palette(.ink)).textSelection(.enabled)
                    }
                }
                row("Ref", palette) {
                    Text(details.ref).font(RelayFont.mono(12)).foregroundStyle(palette(.ink)).textSelection(.enabled)
                }
            }
        } buttons: {
            SecondaryButton(title: "Copy commit") { copy(details.commit) }
            SecondaryButton(title: "Close", action: close)
        }
    }

    private func row(_ label: String, _ palette: Palette, @ViewBuilder value: () -> some View) -> some View {
        GridRow {
            Text(label)
                .font(RelayFont.text(12))
                .foregroundStyle(palette(.muted))
                .frame(width: 70, alignment: .leading)
            value()
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The frame of a sheet: the card's width and padding, a title, the content, and the buttons
/// at the bottom right (the preview's `dialog`).
struct SheetFrame<Content: View, Buttons: View>: View {
    let title: String
    @ViewBuilder let content: Content
    @ViewBuilder let buttons: Buttons
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let palette = Palette(scheme: scheme)
        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .font(RelayFont.text(18, .semibold))
                .foregroundStyle(palette(.ink))
                .padding(.bottom, 14)
            content
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                buttons
            }
            .padding(.top, 20)
        }
        .padding(22)
        .frame(width: ExpandedCard.width, alignment: .leading)
        .background(palette(.surface))
    }
}
