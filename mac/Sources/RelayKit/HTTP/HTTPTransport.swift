import Darwin
import Foundation

/// Sends one request per connection over relay's socket and reads the answer (design.md decision
/// 5). Every call blocks; `DaemonClient` runs them off the main thread.
struct HTTPTransport: Sendable {
    /// How long one wait for bytes lasts before the time limits are checked again.
    static let pollInterval = 0.1

    let location: SocketLocation
    let expectedUID: uid_t
    let clock: any RelayClock

    private func open(timeout: Double) throws -> UnixSocket {
        try location.check()
        return try UnixSocket.connect(path: location.socketPath, timeout: timeout, expectedUID: expectedUID)
    }

    /// Sends `request` and reads the whole answer, all within `timeout` seconds.
    func send(_ request: [UInt8], timeout: Double) throws -> HTTPResponse {
        let deadline = clock.instant.advanced(by: .seconds(timeout))
        let socket = try open(timeout: timeout)
        defer { socket.close() }
        try socket.writeAll(request)
        var reader = HTTPResponseReader(mode: .wholeBody)
        while !reader.isComplete {
            if clock.instant >= deadline { throw HTTPError.timedOut }
            guard let bytes = try socket.read(waitingAtMost: Self.pollInterval) else { continue }
            if bytes.isEmpty {
                try reader.finish()
            } else {
                _ = try reader.feed(bytes)
            }
        }
        guard let response = reader.response else {
            throw HTTPError.malformedResponse("The response has no body.")
        }
        return response
    }

    /// Sends `request` and hands each piece of a 2xx body to `onBody` as it arrives, until the
    /// daemon closes the connection. The head must arrive within `headTimeout` seconds; after it,
    /// only `inactivityLimit` seconds without bytes end the stream. Any other status throws.
    func stream(
        _ request: [UInt8],
        headTimeout: Double,
        inactivityLimit: Double,
        isCancelled: () -> Bool,
        onBody: ([UInt8]) throws -> Void
    ) throws {
        let deadline = clock.instant.advanced(by: .seconds(headTimeout))
        let socket = try open(timeout: headTimeout)
        defer { socket.close() }
        try socket.writeAll(request)
        var reader = HTTPResponseReader(mode: .streaming)
        var lastBytes = clock.instant
        while !reader.isComplete {
            if isCancelled() { throw CancellationError() }
            let now = clock.instant
            if reader.head == nil ? now >= deadline : lastBytes.duration(to: now) >= .seconds(inactivityLimit) {
                throw HTTPError.timedOut
            }
            guard let bytes = try socket.read(waitingAtMost: Self.pollInterval) else { continue }
            if bytes.isEmpty {
                try reader.finish()
                break
            }
            lastBytes = clock.instant
            let body = try reader.feed(bytes)
            if !body.isEmpty { try onBody(body) }
        }
        if let response = reader.response { throw APIError.decode(response) }
    }
}

extension APIError {
    /// The error carried by a non-2xx answer, or `malformedResponse` when its body is not the
    /// API's error object.
    static func decode(_ response: HTTPResponse) -> Error {
        struct Body: Decodable {
            struct Inner: Decodable {
                let code: String
                let message: String
            }
            let error: Inner
        }
        guard let body = try? JSONDecoder().decode(Body.self, from: Data(response.body)) else {
            return HTTPError.malformedResponse("The error body of a \(response.head.status) answer did not decode.")
        }
        return APIError(status: response.head.status, code: body.error.code, message: body.error.message)
    }
}
