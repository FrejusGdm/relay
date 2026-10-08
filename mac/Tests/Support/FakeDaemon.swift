import Darwin
import Foundation
import RelayKit

/// A Unix-socket server that plays relay's daemon in tests (design.md decision 14). It records each
/// request and answers with a scripted reply.
public final class FakeDaemon: @unchecked Sendable {
    public struct Request: Sendable {
        public let method: String
        public let path: String
        /// Header names in lower case.
        public let headers: [String: String]
        public let head: String
        public let body: [UInt8]
    }

    public enum Reply: Sendable {
        /// These bytes, then the connection closes.
        case raw([UInt8])
        /// A file of `Tests/Fixtures/api/` as a JSON answer.
        case fixture(String, status: Int = 200, streamSeq: Int? = nil)
        /// This JSON text as an answer.
        case json(String, status: Int = 200, streamSeq: Int? = nil)
        /// The head of an event stream, then whatever the test pushes into the feed.
        case feed(EventFeed)
        /// A new feed for each request, kept in `openedFeeds`.
        case newFeedPerRequest
    }

    public let home: String
    public var location: SocketLocation { SocketLocation(home: home) }

    private let lock = NSLock()
    private var replies: [String: Reply] = [:]
    private var recorded: [Request] = []
    private var connectionBytes: [Int] = []
    private var feeds: [EventFeed] = []
    private var newFeeds: [EventFeed] = []
    private var stopped = false
    private var versionPID: Int32 = 4121
    private var versionStartedAt = "2026-10-07T12:02:11.402Z"
    private var versionCapabilities: [String]?

    public init() throws {
        home = try makeTemporaryFolder()
        let directory = home + "/run"
        guard mkdir(directory, 0o700) == 0, chmod(directory, 0o700) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        let path = directory + "/relay.sock"
        let listener = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = sockaddr_un()
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: Array(path.utf8)) }
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard listener >= 0, bound == 0, chmod(path, 0o600) == 0, listen(listener, 64) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        let thread = Thread { [self] in acceptLoop(listener) }
        thread.name = "fake-daemon"
        thread.start()
    }

    deinit {
        stop()
    }

    /// Sets the reply to `method` and `path` (without a query).
    public func reply(_ method: String, _ path: String, with reply: Reply) {
        lock.withLock { replies["\(method) \(path)"] = reply }
    }

    /// Sets what `GET /v1/version` reports.
    public func setVersion(pid: Int32? = nil, startedAt: String? = nil, capabilities: [String]? = nil) {
        lock.withLock {
            if let pid { versionPID = pid }
            if let startedAt { versionStartedAt = startedAt }
            if let capabilities { versionCapabilities = capabilities }
        }
    }

    public var requests: [Request] {
        lock.withLock { recorded }
    }

    /// The feeds made for `newFeedPerRequest` replies, in the order of the requests.
    public var openedFeeds: [EventFeed] {
        lock.withLock { newFeeds }
    }

    /// The requests for `method` and `path`.
    public func requests(_ method: String, _ path: String) -> [Request] {
        requests.filter { $0.method == method && $0.path == path }
    }

    /// How many bytes each finished connection sent, in order.
    public var receivedByteCounts: [Int] {
        lock.withLock { connectionBytes }
    }

    /// Waits up to `timeout` seconds of real time for `condition`.
    public func wait(timeout: Double = 5, until condition: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if condition() { return true }
            usleep(10_000)
        }
        return condition()
    }

    public func stop() {
        let open = lock.withLock {
            stopped = true
            return feeds
        }
        open.forEach { $0.close() }
    }

    private var isStopped: Bool {
        lock.withLock { stopped }
    }

    private func acceptLoop(_ listener: Int32) {
        while !isStopped {
            var request = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
            guard poll(&request, 1, 50) > 0 else { continue }
            let client = accept(listener, nil, nil)
            guard client >= 0 else { continue }
            var one: Int32 = 1
            setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            let thread = Thread { [self] in serve(client) }
            thread.start()
        }
        close(listener)
        try? FileManager.default.removeItem(atPath: home)
    }

    private func serve(_ client: Int32) {
        defer { close(client) }
        var bytes: [UInt8] = []
        var headEnd: Int?
        var contentLength = 0
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            if let headEnd, bytes.count >= headEnd + 4 + contentLength { break }
            var request = pollfd(fd: client, events: Int16(POLLIN), revents: 0)
            guard poll(&request, 1, 5000) > 0 else { break }
            let count = buffer.withUnsafeMutableBytes { read(client, $0.baseAddress, $0.count) }
            if count <= 0 { break }
            bytes.append(contentsOf: buffer[0..<count])
            if headEnd == nil, let end = Self.find([13, 10, 13, 10], in: bytes) {
                headEnd = end
                let head = String(decoding: bytes[..<end], as: UTF8.self)
                contentLength = Self.headers(of: head)["content-length"].flatMap { Int($0) } ?? 0
            }
        }
        lock.withLock { connectionBytes.append(bytes.count) }
        guard let headEnd else { return }

        let head = String(decoding: bytes[..<headEnd], as: UTF8.self)
        let requestLine = head.components(separatedBy: "\r\n")[0].split(separator: " ")
        let method = requestLine.count > 0 ? String(requestLine[0]) : ""
        let target = requestLine.count > 1 ? String(requestLine[1]) : ""
        let path = String(target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0])
        let recordedRequest = Request(
            method: method,
            path: path,
            headers: Self.headers(of: head),
            head: head,
            body: Array(bytes[(headEnd + 4)...])
        )
        let reply = lock.withLock {
            recorded.append(recordedRequest)
            return replies["\(method) \(path)"]
        }

        switch reply {
        case .raw(let raw):
            write(client, raw)
        case .fixture(let name, let status, let streamSeq):
            let body = (try? Fixtures.bytes("api/\(name)")) ?? Array("fixture \(name) is missing".utf8)
            write(client, Self.jsonAnswer(status: status, body: body, streamSeq: streamSeq))
        case .json(let text, let status, let streamSeq):
            write(client, Self.jsonAnswer(status: status, body: Array(text.utf8), streamSeq: streamSeq))
        case .feed(let feed):
            lock.withLock { feeds.append(feed) }
            stream(feed, to: client)
        case .newFeedPerRequest:
            let feed = EventFeed()
            lock.withLock {
                feeds.append(feed)
                newFeeds.append(feed)
            }
            stream(feed, to: client)
        case nil:
            if method == "GET" && path == "/v1/version" {
                write(client, Self.jsonAnswer(status: 200, body: versionBody(), streamSeq: nil))
            } else {
                let body = #"{"error":{"code":"not_found","message":"There is no \#(path)."}}"#
                write(client, Self.jsonAnswer(status: 404, body: Array(body.utf8), streamSeq: nil))
            }
        }
    }

    private func stream(_ feed: EventFeed, to client: Int32) {
        write(client, Array("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".utf8))
        while let chunk = feed.next() {
            if !write(client, chunk) { break }
        }
    }

    private func versionBody() -> [UInt8] {
        let (pid, startedAt, capabilities) = lock.withLock { (versionPID, versionStartedAt, versionCapabilities) }
        guard let data = try? Fixtures.bytes("api/GET_v1_version.json"),
              var object = try? JSONSerialization.jsonObject(with: Data(data)) as? [String: Any]
        else { return [] }
        object["pid"] = pid
        object["started_at"] = startedAt
        if let capabilities { object["capabilities"] = capabilities }
        return Array((try? JSONSerialization.data(withJSONObject: object)) ?? Data())
    }

    @discardableResult
    private func write(_ client: Int32, _ bytes: [UInt8]) -> Bool {
        var offset = 0
        while offset < bytes.count {
            let written = bytes.withUnsafeBytes { Darwin.write(client, $0.baseAddress! + offset, $0.count - offset) }
            if written <= 0 { return false }
            offset += written
        }
        return true
    }

    private static func jsonAnswer(status: Int, body: [UInt8], streamSeq: Int?) -> [UInt8] {
        var head = "HTTP/1.1 \(status) \(status == 200 ? "OK" : "Error")\r\n"
        head += "Content-Type: application/json; charset=utf-8\r\n"
        head += "Content-Length: \(body.count)\r\n"
        if let streamSeq { head += "Relay-Stream-Seq: \(streamSeq)\r\n" }
        head += "Connection: close\r\n\r\n"
        return Array(head.utf8) + body
    }

    private static func headers(of head: String) -> [String: String] {
        var headers: [String: String] = [:]
        for line in head.components(separatedBy: "\r\n").dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        return headers
    }

    private static func find(_ needle: [UInt8], in bytes: [UInt8]) -> Int? {
        guard bytes.count >= needle.count else { return nil }
        for index in 0...(bytes.count - needle.count) where bytes[index..<(index + needle.count)].elementsEqual(needle) {
            return index
        }
        return nil
    }
}

/// The bytes of an event stream that a test pushes, in order, until it closes the feed.
public final class EventFeed: @unchecked Sendable {
    private let condition = NSCondition()
    private var pending: [[UInt8]] = []
    private var closed = false

    public init() {}

    public func push(_ text: String) {
        push(bytes: Array(text.utf8))
    }

    public func push(bytes: [UInt8]) {
        condition.withLock {
            pending.append(bytes)
            condition.signal()
        }
    }

    public func close() {
        condition.withLock {
            closed = true
            condition.broadcast()
        }
    }

    /// The next pushed bytes, or `nil` once the feed is closed and empty.
    func next() -> [UInt8]? {
        condition.withLock {
            while pending.isEmpty && !closed { condition.wait() }
            return pending.isEmpty ? nil : pending.removeFirst()
        }
    }
}
