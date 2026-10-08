import RelayKit
import SwiftUI

/// The menu-bar window's content: the tiny card, which expands to the full card on a click and
/// collapses with "Show less" (180 ms ease-out, instant with "Reduce motion").
public struct MenuCard: View {
    let model: CardModel
    let actions: CardActions
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(model: CardModel, actions: CardActions) {
        self.model = model
        self.actions = actions
    }

    public var body: some View {
        Group {
            if expanded {
                CardHost(model: model, actions: actions) { setExpanded(false) }
                    .transition(CardMotion.transition)
            } else {
                TinyCard(model: model, actions: actions) { setExpanded(true) }
                    .transition(CardMotion.transition)
            }
        }
        .fixedSize()
    }

    private func setExpanded(_ value: Bool) {
        withAnimation(CardMotion.expand(reduceMotion: reduceMotion)) {
            expanded = value
        }
    }
}
