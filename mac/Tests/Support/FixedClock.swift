import Foundation
import RelayKit

/// A clock that moves only when a test moves it (design.md decision 14). Waits end when the test
/// moves the clock past their end.
public final class FixedClock: RelayClock, @unchecked Sendable {
    private struct Sleeper {
        let end: Date
        let continuation: CheckedContinuation<Void, Error>
    }

    private let lock = NSLock()
    private var current: Date
    private let firstInstant = ContinuousClock.now
    private var moved = Duration.zero
    private var sleepers: [UUID: Sleeper] = [:]

    /// 2026-10-07 14:36:00 UTC, the time of the handoff in the fixtures.
    public init(_ start: Date = Date(timeIntervalSince1970: 1_791_383_760)) {
        current = start
    }

    public var now: Date {
        lock.withLock { current }
    }

    public var instant: ContinuousClock.Instant {
        lock.withLock { firstInstant.advanced(by: moved) }
    }

    /// How many waits have not ended yet.
    public var waitingCount: Int {
        lock.withLock { sleepers.count }
    }

    public func advance(by seconds: Double) {
        let due = lock.withLock {
            current = current.addingTimeInterval(seconds)
            moved += .seconds(seconds)
            let ended = sleepers.filter { $0.value.end <= current }
            for key in ended.keys { sleepers.removeValue(forKey: key) }
            return Array(ended.values)
        }
        due.forEach { $0.continuation.resume() }
    }

    public func sleep(for seconds: Double) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let result: Result<Void, Error>? = lock.withLock {
                    if Task.isCancelled { return .failure(CancellationError()) }
                    let end = current.addingTimeInterval(seconds)
                    if end <= current { return .success(()) }
                    sleepers[id] = Sleeper(end: end, continuation: continuation)
                    return nil
                }
                if let result { continuation.resume(with: result) }
            }
        } onCancel: {
            let sleeper = lock.withLock { sleepers.removeValue(forKey: id) }
            sleeper?.continuation.resume(throwing: CancellationError())
        }
    }
}
