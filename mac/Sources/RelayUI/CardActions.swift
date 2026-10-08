import RelayKit

/// What the card's buttons do outside the card. None of them sends a request to the daemon except
/// the switch sheet's own button, which the person presses after choosing an account.
public struct CardActions {
    public var primary: @MainActor (PrimaryAction) -> Void = { _ in }
    public var copy: @MainActor (String) -> Void = { _ in }
    public var quit: @MainActor () -> Void = {}
    /// The app that runs an agent with this process ID, looked up when a window opens.
    public var findHost: @MainActor (Int32) -> Host? = { _ in nil }
    /// Makes the switch sheet for a job; the "Switch worker…" button appears only when it is set.
    public var makeSwitchFlow: (@MainActor (String) -> SwitchFlow?)?

    public init() {}
}

/// A view that replaces the card inside its window until it is closed.
public enum CardPanel {
    case checkpoint(CheckpointDetails)
    case switchWorker(SwitchFlow)
}
