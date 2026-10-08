import AppKit
import RelayKit
import RelayUI
import SwiftUI

@main
struct RelayApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            MenuContent(store: delegate.store)
        } label: {
            MenuBarLabel(store: delegate.store)
        }
        .menuBarExtraStyle(.window)
    }
}

/// Creates the store at launch and follows the daemon for the app's whole life.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let store = RelayStore(client: DaemonClient(location: .resolve()))
    private var following: Task<Void, Never>?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let resources = Bundle.main.resourceURL {
            FontLoader.register(directory: resources.appendingPathComponent("Fonts"))
        }
        let store = store
        following = Task { await store.run() }
    }
}

@MainActor
private func cardModel(_ store: RelayStore) -> CardModel {
    CardModel.make(store.cardInput(), now: store.now, calendar: .autoupdatingCurrent, locale: .autoupdatingCurrent)
}

/// The template glyph; its accessibility label carries the status line.
struct MenuBarLabel: View {
    let store: RelayStore

    var body: some View {
        Image(nsImage: RelayGlyph.menuBarImage())
            .accessibilityLabel(cardModel(store).accessibilityLabel)
    }
}

struct MenuContent: View {
    let store: RelayStore

    var body: some View {
        MenuCard(model: cardModel(store), actions: actions)
            .onAppear { store.windowOpened() }
            .onDisappear { store.windowClosed() }
    }

    private var actions: CardActions {
        var actions = CardActions()
        actions.primary = { action in
            if case .showInFinder(let path) = action {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
            }
        }
        actions.copy = { text in
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
        actions.quit = { NSApp.terminate(nil) }
        return actions
    }
}
