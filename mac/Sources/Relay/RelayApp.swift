import RelayUI
import SwiftUI

@main
struct RelayApp: App {
    init() {
        if let resources = Bundle.main.resourceURL {
            FontLoader.register(directory: resources.appendingPathComponent("Fonts"))
        }
    }

    var body: some Scene {
        MenuBarExtra("relay") {
            Text("relay")
                .padding()
        }
        .menuBarExtraStyle(.window)
    }
}
