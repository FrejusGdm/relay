import AppKit
import RelayKit
import SwiftUI

/// The windows that `relay://job/<id>` links open: one per job, reused when the same link opens
/// again (design.md decision 12). A link only opens a view; nothing here sends a `POST`.
@MainActor
public final class LinkWindows {
    public private(set) var windows: [String: NSWindow] = [:]
    /// How many times each job's window was shown; each showing looks the agent's app up again.
    public private(set) var presentations: [String: Int] = [:]
    private var controllers: [String: NSHostingController<StoreCard>] = [:]

    private let store: RelayStore
    private let actions: CardActions
    private let present: @MainActor (NSWindow) -> Void

    public init(
        store: RelayStore,
        actions: CardActions,
        present: @escaping @MainActor (NSWindow) -> Void = { window in
            window.makeKeyAndOrderFront(nil)
            NSApp.activate()
        }
    ) {
        self.store = store
        self.actions = actions
        self.present = present
    }

    /// Opens the window of the job a valid link names, and ignores every other link.
    public func open(_ url: URL) {
        guard let jobID = RelayLink.parse(url) else { return }
        let count = (presentations[jobID] ?? 0) + 1
        presentations[jobID] = count
        if let window = windows[jobID] {
            controllers[jobID]?.rootView = StoreCard(store: store, jobID: jobID, actions: actions, lookup: count)
            present(window)
            return
        }
        let controller = NSHostingController(rootView: StoreCard(store: store, jobID: jobID, actions: actions, lookup: count))
        controllers[jobID] = controller
        controller.sizingOptions = .preferredContentSize
        let window = NSWindow(contentViewController: controller)
        window.title = "relay"
        window.styleMask = [.titled, .closable]
        window.isReleasedWhenClosed = false
        windows[jobID] = window
        store.openLink(jobID)
        _ = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.closed(jobID) }
        }
        present(window)
    }

    private func closed(_ jobID: String) {
        guard windows.removeValue(forKey: jobID) != nil else { return }
        controllers.removeValue(forKey: jobID)
        presentations.removeValue(forKey: jobID)
        store.closeLink(jobID)
    }
}
