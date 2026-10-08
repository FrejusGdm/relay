import RelayKit
import SwiftUI

/// The expanded card with its panels: "View checkpoint" and "Switch worker…" replace the card in
/// the same window until they close. A window of a menu-bar app has no stable parent for a
/// system sheet, so the panels are shown in place.
public struct CardHost: View {
    let model: CardModel
    let actions: CardActions
    let showLess: (() -> Void)?
    @State private var panel: CardPanel?

    public init(model: CardModel, actions: CardActions, showLess: (() -> Void)? = nil) {
        self.model = model
        self.actions = actions
        self.showLess = showLess
    }

    public var body: some View {
        switch panel {
        case .checkpoint(let details):
            CheckpointSheet(details: details, copy: actions.copy) { panel = nil }
        case .switchWorker(let flow):
            SwitchSheet(flow: flow, copy: actions.copy) { panel = nil }
                .onDisappear { flow.dismiss() }
        case nil:
            ExpandedCard(model: model, actions: actions, showLess: showLess) { panel = $0 }
        }
    }
}

/// The card of the store's state: the menu-bar card when `jobID` is `nil`, which starts tiny and
/// expands on a click, or the expanded card of one job in a `relay://` window. The app that runs
/// the agent is looked up when the view appears, when the agent's process changes (after a switch,
/// or when a link's job arrives), and each time `lookup` changes (a link window shown again).
public struct StoreCard: View {
    let store: RelayStore
    let jobID: String?
    let actions: CardActions
    let lookup: Int
    @State private var host: AgentHost?

    public init(store: RelayStore, jobID: String? = nil, actions: CardActions, lookup: Int = 0) {
        self.store = store
        self.jobID = jobID
        self.actions = actions
        self.lookup = lookup
    }

    public var body: some View {
        let model = CardModel.make(
            store.cardInput(jobID: jobID, host: host),
            now: store.now,
            calendar: .autoupdatingCurrent,
            locale: .autoupdatingCurrent
        )
        Group {
            if jobID == nil {
                MenuCard(model: model, actions: actions)
            } else {
                CardHost(model: model, actions: actions)
            }
        }
        .task(id: HostLookup(agentPID: store.agentPID(jobID: jobID), lookup: lookup)) {
            host = store.agentPID(jobID: jobID).flatMap { actions.findHost($0) }
        }
    }
}

private struct HostLookup: Equatable {
    let agentPID: Int32?
    let lookup: Int
}
