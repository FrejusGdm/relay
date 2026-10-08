import RelayKit
import SwiftUI

/// The expanded card, 376 points wide (`.rc-card` in `docs/design/preview.html`), in the order
/// `DESIGN.md` fixes: head, job, status line, workers, facts, actions.
public struct ExpandedCard: View {
    public nonisolated static let width: CGFloat = 376

    let model: CardModel
    let actions: CardActions
    let showLess: (() -> Void)?
    let openPanel: (CardPanel) -> Void
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// `showLess` is `nil` in a `relay://` window, which has no tiny card to go back to.
    public init(
        model: CardModel,
        actions: CardActions = CardActions(),
        showLess: (() -> Void)? = nil,
        openPanel: @escaping (CardPanel) -> Void = { _ in }
    ) {
        self.model = model
        self.actions = actions
        self.showLess = showLess
        self.openPanel = openPanel
    }

    public var body: some View {
        let palette = Palette(scheme: scheme)
        VStack(alignment: .leading, spacing: 0) {
            head(palette)
            switch model {
            case .job(let card):
                job(card, palette)
            case .state(let card):
                state(card, palette)
            }
        }
        .padding(22)
        .frame(width: Self.width, alignment: .leading)
        .background(palette(.surface))
    }

    private func head(_ palette: Palette) -> some View {
        HStack(spacing: 8) {
            RelayGlyph()
                .stroke(palette(.ink), style: StrokeStyle(lineWidth: 1.6, lineJoin: .miter))
                .frame(width: 16, height: 12)
            Text("relay")
                .font(RelayFont.text(14, .semibold))
                .tracking(-0.14)
                .foregroundStyle(palette(.ink))
            Spacer(minLength: 0)
            if let showLess { headButton("Show less", palette, action: showLess) }
            headButton("Quit", palette, action: actions.quit)
        }
        .padding(.bottom, 24)
    }

    private func headButton(_ title: String, _ palette: Palette, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(RelayFont.text(12))
                .foregroundStyle(palette(.muted))
                .padding(4)
        }
        .buttonStyle(PressStyle())
    }

    private func title(_ text: String, _ palette: Palette) -> some View {
        Text(text)
            .font(RelayFont.display(23))
            .tracking(-0.028 * 23)
            .lineSpacing(1)
            .foregroundStyle(palette(.ink))
            .fixedSize(horizontal: false, vertical: true)
    }

    private func rule(_ palette: Palette) -> some View {
        Rectangle().fill(palette(.rule)).frame(height: 1)
    }

    @ViewBuilder
    private func job(_ card: JobCard, _ palette: Palette) -> some View {
        title(card.title, palette)
        HStack(spacing: 6) {
            FolderIcon().line(palette(card.projectMissing ? .warning : .muted), width: 0.95)
                .frame(width: 13, height: 13)
            card.repository.rendered(size: 13, color: palette(card.projectMissing ? .warning : .muted), palette: palette)
                .lineLimit(1)
        }
        .padding(.top, 7)

        rule(palette).padding(.top, 21)
        card.status.rendered(size: 13, weight: .medium, color: palette(.ink), palette: palette)
            .lineSpacing(5)
            .fixedSize(horizontal: false, vertical: true)
            .contentTransition(.opacity)
            .animation(CardMotion.text(reduceMotion: reduceMotion), value: card.status)
            .frame(maxWidth: .infinity, minHeight: 50, alignment: .topLeading)
            .padding(.top, 17)

        VStack(spacing: 0) {
            ForEach(Array(card.rows.enumerated()), id: \.offset) { index, row in
                if index > 0, let connector = card.connector {
                    ConnectorView(connector: connector)
                }
                WorkerRowView(row: row)
            }
        }

        rule(palette).padding(.top, 21)
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 9, verticalSpacing: 8) {
            ForEach(card.facts, id: \.label) { fact in
                GridRow {
                    Text(fact.label)
                        .font(RelayFont.text(12))
                        .foregroundStyle(palette(.muted))
                        .frame(width: 85, alignment: .leading)
                    fact.value.rendered(size: 12, color: palette(.ink), palette: palette)
                }
            }
        }
        .padding(.top, 17)

        VStack(spacing: 0) {
            if let action = card.primaryAction {
                PrimaryButton(label: action.label) { actions.primary(action) }
            }
            let checkpoint = card.showsViewCheckpoint ? card.checkpoint : nil
            let makeSwitchFlow = card.showsSwitchWorker ? actions.makeSwitchFlow : nil
            if checkpoint != nil || makeSwitchFlow != nil {
                HStack {
                    if let checkpoint {
                        TextButton(title: "View checkpoint") { openPanel(.checkpoint(checkpoint)) }
                    }
                    Spacer(minLength: 0)
                    if let makeSwitchFlow {
                        TextButton(title: "Switch worker…") {
                            if let flow = makeSwitchFlow(card.jobID) { openPanel(.switchWorker(flow)) }
                        }
                    }
                }
                .padding(.top, 12)
            }
        }
        .padding(.top, 22)
    }

    @ViewBuilder
    private func state(_ card: StateCard, _ palette: Palette) -> some View {
        title(card.title, palette)
        card.message.rendered(size: 13, color: palette(.muted), palette: palette)
            .lineSpacing(5)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 10)
        if let command = card.command {
            PrimaryButton(label: "Copy command") { actions.copy(command) }
                .padding(.top, 22)
        }
    }
}
