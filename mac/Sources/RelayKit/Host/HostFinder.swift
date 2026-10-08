/// The app that runs an agent, for example Terminal.
public struct Host: Equatable, Sendable {
    public let pid: Int32
    public let name: String

    public init(pid: Int32, name: String) {
        self.pid = pid
        self.name = name
    }
}

/// Finds the app that runs an agent by walking up its parent processes (design.md decision 10).
/// The app looks it up each time a window opens, never in the background.
@MainActor
public struct HostFinder {
    public static let maxSteps = 32

    let table: any ProcessTable
    let workspace: any Workspace

    public init(table: any ProcessTable = SystemProcessTable(), workspace: any Workspace) {
        self.table = table
        self.workspace = workspace
    }

    /// The first regular app among `pid` and its ancestors, at most 32 steps and stopping at
    /// process 1. `nil` for a headless worker, an agent inside `tmux`, or a host that quit.
    public func host(of pid: Int32) -> Host? {
        var current = pid
        for _ in 0..<Self.maxSteps {
            guard current > 1 else { return nil }
            if let name = workspace.regularAppName(pid: current) {
                return Host(pid: current, name: name)
            }
            guard let parent = table.parent(of: current), parent != current else { return nil }
            current = parent
        }
        return nil
    }
}

extension PrimaryAction {
    /// Opens the view the action names. It never sends a request to the daemon.
    @MainActor
    public func perform(in workspace: any Workspace) {
        switch self {
        case .openHost(_, _, let pid): workspace.activate(pid: pid)
        case .showInFinder(let path): workspace.showInFinder(path: path)
        }
    }
}
