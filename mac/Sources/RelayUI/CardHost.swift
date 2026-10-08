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
        case nil:
            ExpandedCard(model: model, actions: actions, showLess: showLess) { panel = $0 }
        }
    }
}

/// The card of the store's state: the menu-bar card when `jobID` is `nil`, which starts tiny and
/// expands on a click, or the expanded card of one job in a `relay://` window. The app that runs
/// the agent is looked up when the view appears.
public struct StoreCard: View {
    let store: RelayStore
    let jobID: String?
    let actions: CardActions
    @State private var host: AgentHost?

    public init(store: RelayStore, jobID: String? = nil, actions: CardActions) {
        self.store = store
        self.jobID = jobID
        self.actions = actions
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
        .onAppear {
            if let pid = store.agentPID(jobID: jobID) {
                host = actions.findHost(pid)
            } else {
                host = nil
            }
        }
    }
}
