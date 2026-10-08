import RelayKit
import SwiftUI

/// The menu-bar card, 280 points wide (`.rc-tiny` in `docs/design/preview.html`). Clicking it
/// anywhere except the action expands it.
public struct TinyCard: View {
    public static let width: CGFloat = 280

    let model: CardModel
    let actions: CardActions
    let expand: () -> Void
    @Environment(\.colorScheme) private var scheme

    public init(model: CardModel, actions: CardActions = CardActions(), expand: @escaping () -> Void = {}) {
        self.model = model
        self.actions = actions
        self.expand = expand
    }

    public var body: some View {
        let palette = Palette(scheme: scheme)
        VStack(alignment: .leading, spacing: 0) {
            switch model {
            case .job(let card):
                job(card, palette)
            case .state(let card):
                Text(card.title)
                    .font(RelayFont.text(13, .semibold))
                    .foregroundStyle(palette(.ink))
                card.message.rendered(size: 11, color: palette(.muted), palette: palette)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 4)
            }
        }
        .padding(16)
        .frame(width: Self.width, alignment: .leading)
        .background(palette(.surface))
        .contentShape(Rectangle())
        .onTapGesture(perform: expand)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Shows more")
    }

    @ViewBuilder
    private func job(_ card: JobCard, _ palette: Palette) -> some View {
        Text(card.title)
            .font(RelayFont.text(13, .semibold))
            .foregroundStyle(palette(.ink))
            .lineLimit(1)
        card.repository.rendered(size: 11, color: palette(card.projectMissing ? .warning : .muted), palette: palette)
            .lineLimit(1)
            .padding(.top, 3)
        HStack(spacing: 5) {
            RightArrow().line(palette(.accent), width: 0.9)
                .frame(width: 11, height: 11)
            Text(card.status.plain)
                .font(RelayFont.text(10.5))
                .foregroundStyle(palette(.accent))
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .padding(.top, 13)
        Rectangle()
            .fill(palette(.rule))
            .frame(height: 1)
            .padding(.top, 13)
        HStack(spacing: 8) {
            Text(card.tinyNote)
                .font(RelayFont.text(10))
                .foregroundStyle(palette(.muted))
                .lineLimit(1)
            Spacer(minLength: 0)
            if let action = card.primaryAction {
                Button {
                    actions.primary(action)
                } label: {
                    Text(action.tinyLabel)
                        .font(RelayFont.text(11, .semibold))
                        .foregroundStyle(palette(.accent))
                        .lineLimit(1)
                }
                .buttonStyle(PressStyle())
                .accessibilityLabel(action.label)
            }
        }
        .padding(.top, 11)
    }
}
