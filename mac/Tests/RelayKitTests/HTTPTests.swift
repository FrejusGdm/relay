import Darwin
import Foundation
@testable import RelayKit
import RelayTestSupport
import Testing

@Suite(.timeLimit(.minutes(1)))
struct HTTPTests {
    @Test func getIsWrittenByteForByte() {
        let bytes = HTTPRequest.get("/v1/jobs").serialized(userAgent: "relay-mac/0.8.0")
        let expected = "GET /v1/jobs HTTP/1.1\r\nHost: relay\r\nAccept: application/json\r\nUser-Agent: relay-mac/0.8.0\r\n\r\n"
        #expect(String(decoding: bytes, as: UTF8.self) == expected)
    }

    @Test func postIsWrittenByteForByte() {
        let body = Array(#"{"target":"codex:personal","confirm_new_provider":false}"#.utf8)
        let bytes = HTTPRequest.post("/v1/jobs/3f9a2c1d/switch", json: body).serialized(userAgent: "relay-mac/0.8.0")
        let expected = "POST /v1/jobs/3f9a2c1d/switch HTTP/1.1\r\nHost: relay\r\nAccept: application/json\r\n"
            + "User-Agent: relay-mac/0.8.0\r\nContent-Type: application/json\r\nContent-Length: 56\r\n\r\n"
            + #"{"target":"codex:personal","confirm_new_provider":false}"#
        #expect(String(decoding: bytes, as: UTF8.self) == expected)
    }

    @Test func requestsCarryNoOriginCookieOrAuthorization() async throws {
        let fake = try FakeDaemon()
        defer { fake.stop() }
        fake.reply("GET", "/v1/jobs", with: .fixture("GET_v1_jobs.handoff.json"))
        let client = DaemonClient(location: fake.location, appVersion: "0.8.0")
        _ = try await client.jobs()
        let request = try #require(fake.requests.first)
        #expect(request.head == "GET /v1/jobs HTTP/1.1\r\nHost: relay\r\nAccept: application/json\r\nUser-Agent: relay-mac/0.8.0")
        for name in ["origin", "cookie", "authorization", "transfer-encoding"] {
            #expect(request.headers[name] == nil)
        }
    }

    static let validResponse = Array(
        ("HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: 12\r\n"
            + "Relay-Stream-Seq: 4180\r\nConnection: close\r\n\r\n{\"jobs\":[]}\n").utf8
    )

    @Test func responseSplitAtEveryByteDecodesTheSame() throws {
        var whole = HTTPResponseReader(mode: .wholeBody)
        _ = try whole.feed(Self.validResponse)
        let expected = try #require(whole.response)
        #expect(expected.head.status == 200)
        #expect(expected.head.value("Relay-Stream-Seq") == "4180")
        #expect(String(decoding: expected.body, as: UTF8.self) == "{\"jobs\":[]}\n")

        for split in 0...Self.validResponse.count {
            var reader = HTTPResponseReader(mode: .wholeBody)
            _ = try reader.feed(Array(Self.validResponse[..<split]))
            _ = try reader.feed(Array(Self.validResponse[split...]))
            #expect(reader.response == expected, "split at byte \(split)")
        }
        var byByte = HTTPResponseReader(mode: .wholeBody)
        for byte in Self.validResponse { _ = try byByte.feed([byte]) }
        #expect(byByte.response == expected)
    }

    @Test func bodyWithoutContentLengthIsReadUntilClose() throws {
        var reader = HTTPResponseReader(mode: .wholeBody)
        _ = try reader.feed(Array("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"jo".utf8))
        _ = try reader.feed(Array("bs\":[]}".utf8))
        #expect(reader.response == nil)
        try reader.finish()
        #expect(String(decoding: try #require(reader.response).body, as: UTF8.self) == "{\"jobs\":[]}")
    }

    @Test func headWithoutEndWithin16KiBFails() {
        var reader = HTTPResponseReader(mode: .wholeBody)
        let head = "HTTP/1.1 200 OK\r\nX-Padding: " + String(repeating: "a", count: 16 * 1024)
        expectMalformed { _ = try reader.feed(Array(head.utf8)) }
    }

    @Test func chunkedTransferEncodingFails() {
        var reader = HTTPResponseReader(mode: .wholeBody)
        let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n"
        expectMalformed { _ = try reader.feed(Array(response.utf8)) }
    }

    @Test func bodyOver4MiBFails() throws {
        var declared = HTTPResponseReader(mode: .wholeBody)
        let head = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 4194305\r\n\r\n"
        #expect(throws: HTTPError.responseTooLarge) { _ = try declared.feed(Array(head.utf8)) }

        var undeclared = HTTPResponseReader(mode: .wholeBody)
        _ = try undeclared.feed(Array("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n".utf8))
        _ = try undeclared.feed([UInt8](repeating: 32, count: 4 * 1024 * 1024))
        #expect(throws: HTTPError.responseTooLarge) { _ = try undeclared.feed([32]) }
    }

    @Test func statusLineThatIsNotHTTP11Fails() {
        var reader = HTTPResponseReader(mode: .wholeBody)
        expectMalformed { _ = try reader.feed(Array("HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n".utf8)) }
    }

    @Test func wrongContentTypeFails() {
        var html = HTTPResponseReader(mode: .wholeBody)
        expectMalformed { _ = try html.feed(Array("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 0\r\n\r\n".utf8)) }
        var jsonStream = HTTPResponseReader(mode: .streaming)
        expectMalformed { _ = try jsonStream.feed(Array("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n".utf8)) }
    }

    @Test func streamBodyReachesTheParserChunkByChunk() async throws {
        let fake = try FakeDaemon()
        defer { fake.stop() }
        let feed = EventFeed()
        fake.reply("GET", "/v1/events", with: .feed(feed))
        let clock = FixedClock()
        let transport = HTTPTransport(location: fake.location, expectedUID: getuid(), clock: clock)
        let received = Collector()
        let streaming = Task.detached {
            try transport.stream(
                HTTPRequest.events(lastEventID: nil).serialized(userAgent: "relay-mac/0.0.0"),
                headTimeout: 2,
                inactivityLimit: 45,
                isCancelled: { false },
                onBody: { received.append($0) }
            )
        }

        feed.push("first")
        #expect(received.wait { received.text == "first" })
        clock.advance(by: 10)
        feed.push("second")
        #expect(received.wait { received.text == "firstsecond" })

        let piece = [UInt8](repeating: 120, count: 256 * 1024)
        for _ in 0..<20 { feed.push(bytes: piece) }
        feed.close()
        try await streaming.value
        #expect(received.count == 11 + 20 * piece.count)
    }

    @Test func errorBodyBecomesAPIError() async throws {
        let fake = try FakeDaemon()
        defer { fake.stop() }
        fake.reply("GET", "/v1/jobs/ffffffff", with: .fixture("GET_v1_jobs_ffffffff.job_not_found.json", status: 404))
        let client = DaemonClient(location: fake.location)
        await #expect(throws: APIError(status: 404, code: "job_not_found", message: "No job with id ffffffff.")) {
            _ = try await client.job("ffffffff")
        }
    }

    private func expectMalformed(sourceLocation: SourceLocation = #_sourceLocation, _ body: () throws -> Void) {
        do {
            try body()
            Issue.record("Expected malformedResponse", sourceLocation: sourceLocation)
        } catch let error as HTTPError {
            guard case .malformedResponse = error else {
                Issue.record("Expected malformedResponse, got \(error)", sourceLocation: sourceLocation)
                return
            }
        } catch {
            Issue.record("Expected malformedResponse, got \(error)", sourceLocation: sourceLocation)
        }
    }
}

/// Collects stream bytes from another thread.
final class Collector: @unchecked Sendable {
    private let lock = NSLock()
    private var bytes: [UInt8] = []

    func append(_ more: [UInt8]) {
        lock.withLock { bytes.append(contentsOf: more) }
    }

    var count: Int { lock.withLock { bytes.count } }
    var text: String { lock.withLock { String(decoding: bytes, as: UTF8.self) } }

    func wait(timeout: Double = 5, until condition: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if condition() { return true }
            usleep(10_000)
        }
        return condition()
    }
}
