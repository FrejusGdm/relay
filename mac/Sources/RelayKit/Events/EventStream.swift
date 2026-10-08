import Foundation

extension DaemonClient {
    /// Follows `GET /v1/events` on its own thread. Each event is delivered as soon as its blank
    /// line arrives. The stream ends when the daemon closes it, fails after 45 seconds without a
    /// byte, and has no other time or size limit (design.md decisions 5 and 7).
    public func events(lastEventID: Int?) -> AsyncThrowingStream<ServerEvent, Error> {
        let (stream, continuation) = AsyncThrowingStream<ServerEvent, Error>.makeStream()
        let cancelled = CancelFlag()
        continuation.onTermination = { _ in cancelled.set() }
        let request = HTTPRequest.events(lastEventID: lastEventID).serialized(userAgent: userAgent)
        let transport = self.transport
        let thread = Thread {
            do {
                var parser = SSEParser()
                try transport.stream(
                    request,
                    headTimeout: Self.requestTimeout,
                    inactivityLimit: Self.streamInactivityLimit,
                    isCancelled: { cancelled.isSet }
                ) { bytes in
                    for output in try parser.feed(bytes) {
                        continuation.yield(ServerEvent(output))
                    }
                }
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
        thread.name = "relay-events"
        thread.start()
        return stream
    }
}

final class CancelFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    var isSet: Bool {
        lock.withLock { value }
    }

    func set() {
        lock.withLock { value = true }
    }
}
