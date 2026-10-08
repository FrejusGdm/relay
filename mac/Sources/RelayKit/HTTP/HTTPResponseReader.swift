import Foundation

public struct HTTPResponseHead: Equatable, Sendable {
    public let status: Int
    /// Header names in lower case.
    public let headers: [String: String]

    public func value(_ name: String) -> String? {
        headers[name.lowercased()]
    }
}

public struct HTTPResponse: Equatable, Sendable {
    public let head: HTTPResponseHead
    public let body: [UInt8]
}

/// Reads one answer from bytes as they arrive (design.md decision 5). In whole-body mode the body
/// is kept, up to 4 MiB. In streaming mode, the body of a 2xx answer is handed back piece by piece
/// and not kept; any other answer is read whole, because it is an error body.
public struct HTTPResponseReader: Sendable {
    public enum Mode: Sendable {
        case wholeBody
        case streaming
    }

    public static let maxHeadBytes = 16 * 1024
    public static let maxBodyBytes = 4 * 1024 * 1024

    private let mode: Mode
    private var headBytes: [UInt8] = []
    private var body: [UInt8] = []
    private var contentLength: Int?
    private var streamsBody = false
    public private(set) var head: HTTPResponseHead?
    public private(set) var isComplete = false

    public init(mode: Mode) {
        self.mode = mode
    }

    /// The whole answer, once it is complete and its body was kept.
    public var response: HTTPResponse? {
        guard isComplete, !streamsBody, let head else { return nil }
        return HTTPResponse(head: head, body: body)
    }

    /// Feeds the next bytes. Returns the body bytes of a streamed answer, and nothing otherwise.
    public mutating func feed(_ bytes: [UInt8]) throws -> [UInt8] {
        if isComplete { return [] }
        guard head == nil else { return try takeBody(bytes[...]) }
        let searchFrom = max(0, headBytes.count - 3)
        headBytes.append(contentsOf: bytes)
        guard let end = Self.endOfHead(in: headBytes, from: searchFrom) else {
            if headBytes.count >= Self.maxHeadBytes {
                throw HTTPError.malformedResponse("The response head did not end within 16 KiB.")
            }
            return []
        }
        guard end + 4 <= Self.maxHeadBytes else {
            throw HTTPError.malformedResponse("The response head did not end within 16 KiB.")
        }
        let rest = headBytes[(end + 4)...]
        try parseHead(Array(headBytes[..<end]))
        headBytes = []
        return try takeBody(rest)
    }

    /// Tells the reader that the daemon closed the connection.
    public mutating func finish() throws {
        if isComplete { return }
        guard head != nil else {
            throw HTTPError.malformedResponse("The connection closed before the response head ended.")
        }
        if !streamsBody, let contentLength, body.count < contentLength {
            throw HTTPError.malformedResponse("The connection closed before the body ended.")
        }
        isComplete = true
    }

    private static func endOfHead(in bytes: [UInt8], from start: Int) -> Int? {
        guard bytes.count >= 4 else { return nil }
        var index = start
        while index + 3 < bytes.count {
            if bytes[index] == 13, bytes[index + 1] == 10, bytes[index + 2] == 13, bytes[index + 3] == 10 {
                return index
            }
            index += 1
        }
        return nil
    }

    private mutating func parseHead(_ bytes: [UInt8]) throws {
        let text = String(decoding: bytes, as: UTF8.self)
        var lines = text.components(separatedBy: "\r\n")
        let statusLine = lines.removeFirst()
        let parts = Array(statusLine.utf8)
        guard statusLine.hasPrefix("HTTP/1.1 "), parts.count >= 13,
              parts[9...11].allSatisfy({ $0 >= 48 && $0 <= 57 }), parts[12] == 32,
              let status = Int(String(decoding: parts[9...11], as: UTF8.self))
        else {
            throw HTTPError.malformedResponse("The status line is not HTTP/1.1: \(statusLine)")
        }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else {
                throw HTTPError.malformedResponse("A header line has no colon.")
            }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            guard !name.isEmpty else { throw HTTPError.malformedResponse("A header line has no name.") }
            headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        if headers["transfer-encoding"] != nil {
            throw HTTPError.malformedResponse("The response uses Transfer-Encoding.")
        }
        let success = (200..<300).contains(status)
        streamsBody = mode == .streaming && success
        let expectedType = streamsBody ? "text/event-stream" : "application/json"
        guard let contentType = headers["content-type"], contentType.lowercased().hasPrefix(expectedType) else {
            throw HTTPError.malformedResponse("The response is not \(expectedType).")
        }
        if !streamsBody, let lengthText = headers["content-length"] {
            guard !lengthText.isEmpty, lengthText.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) else {
                throw HTTPError.malformedResponse("The Content-Length header is not a number.")
            }
            guard let length = Int(lengthText), length <= Self.maxBodyBytes else { throw HTTPError.responseTooLarge }
            contentLength = length
        }
        head = HTTPResponseHead(status: status, headers: headers)
        if contentLength == 0 { isComplete = true }
    }

    private mutating func takeBody(_ bytes: ArraySlice<UInt8>) throws -> [UInt8] {
        if streamsBody { return Array(bytes) }
        body.append(contentsOf: bytes)
        if let contentLength {
            if body.count >= contentLength {
                body.removeLast(body.count - contentLength)
                isComplete = true
            }
        } else if body.count > Self.maxBodyBytes {
            throw HTTPError.responseTooLarge
        }
        return []
    }
}
