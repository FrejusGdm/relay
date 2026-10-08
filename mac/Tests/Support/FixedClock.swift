import Foundation
import RelayKit

/// A clock that moves only when a test moves it (design.md decision 14).
public final class FixedClock: RelayClock, @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date

    /// 2026-10-07 14:36:00 UTC, the time of the handoff in the fixtures.
    public init(_ start: Date = Date(timeIntervalSince1970: 1_791_383_760)) {
        current = start
    }

    public var now: Date {
        lock.withLock { current }
    }

    public func advance(by seconds: Double) {
        lock.withLock { current = current.addingTimeInterval(seconds) }
    }
}
