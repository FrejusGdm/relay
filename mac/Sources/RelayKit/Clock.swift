import Foundation

/// The source of the current time and of waits. Tests pass a clock they move by hand (design.md
/// decision 14).
public protocol RelayClock: Sendable {
    /// The wall-clock time, for the card's text.
    var now: Date { get }
    /// A monotonic time, for every time limit, so that a change of the system clock cannot end or
    /// stretch one.
    var instant: ContinuousClock.Instant { get }
    /// Waits `seconds` on this clock. Throws `CancellationError` when the task is cancelled.
    func sleep(for seconds: Double) async throws
}

public struct SystemClock: RelayClock {
    public init() {}

    public var now: Date { Date() }

    public var instant: ContinuousClock.Instant { ContinuousClock.now }

    public func sleep(for seconds: Double) async throws {
        try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }
}
