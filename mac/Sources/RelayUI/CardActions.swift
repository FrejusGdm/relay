/// What the card's buttons do. The card only opens views, copies text or quits; the actions that
/// later tasks add (the checkpoint sheet and the switch) show their buttons only when set.
public struct CardActions {
    public var primary: (PrimaryAction) -> Void = { _ in }
    public var copy: (String) -> Void = { _ in }
    public var quit: () -> Void = {}
    public var viewCheckpoint: (() -> Void)?
    public var switchWorker: (() -> Void)?

    public init() {}
}
