import AppKit
import RelayKit
import RelayUI
import SwiftUI

@main
struct RelayApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            StoreCard(store: delegate.store, actions: delegate.actions)
                .onAppear { delegate.store.windowOpened() }
                .onDisappear { delegate.store.windowClosed() }
        } label: {
            MenuBarLabel(store: delegate.store)
        }
        .menuBarExtraStyle(.window)
    }
}

/// Creates the store at launch, follows the daemon for the app's whole life, and opens
/// `relay://` links.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let store = RelayStore(client: DaemonClient(location: .resolve()))
    private(set) lazy var actions = makeActions()
    private lazy var links = LinkWindows(store: store, actions: actions)
    private var following: Task<Void, Never>?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let resources = Bundle.main.resourceURL {
            FontLoader.register(directory: resources.appendingPathComponent("Fonts"))
        }
        let store = store
        following = Task { await store.run() }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            links.open(url)
        }
    }

    private func makeActions() -> CardActions {
        let workspace = SystemWorkspace()
        let store = store
        var actions = CardActions()
        actions.primary = { store.perform($0, in: workspace) }
        actions.copy = { workspace.copy($0) }
        actions.quit = { NSApp.terminate(nil) }
        actions.findHost = { HostFinder(workspace: workspace).host(of: $0) }
        actions.makeSwitchFlow = { store.switchFlow(jobID: $0) }
        return actions
    }
}

/// The template glyph; its accessibility label carries the status line.
struct MenuBarLabel: View {
    let store: RelayStore

    var body: some View {
        let model = CardModel.make(store.cardInput(), now: store.now, calendar: .autoupdatingCurrent, locale: .autoupdatingCurrent)
        Image(nsImage: RelayGlyph.menuBarImage())
            .accessibilityLabel(model.accessibilityLabel)
    }
}
