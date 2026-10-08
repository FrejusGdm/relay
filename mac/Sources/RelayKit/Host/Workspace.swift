import AppKit

/// The few things the app asks of macOS when a button opens a view: find and bring forward an
/// app, select a folder in Finder, put text on the clipboard. None of them reaches the daemon.
@MainActor
public protocol Workspace {
    /// The name of the app with this process ID when it is a regular app (one with a Dock icon).
    func regularAppName(pid: Int32) -> String?
    func activate(pid: Int32)
    func showInFinder(path: String)
    func copy(_ text: String)
}

public struct SystemWorkspace: Workspace {
    public init() {}

    public func regularAppName(pid: Int32) -> String? {
        guard let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy == .regular else { return nil }
        return app.localizedName
    }

    public func activate(pid: Int32) {
        NSRunningApplication(processIdentifier: pid)?.activate()
    }

    public func showInFinder(path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    public func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
