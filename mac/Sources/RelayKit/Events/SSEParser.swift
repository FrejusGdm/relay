/// One event of a server-sent events stream, before its data is decoded.
public struct SSEEvent: Equatable, Sendable {
    /// The last `id:` seen on the stream, which per the server-sent events rules carries over to
    /// later events that have none.
    public let id: String?
    public let type: String
    public let data: String
}

/// Turns stream bytes into events by the server-sent events rules (design.md decision 7). It keeps
/// only the unfinished line and the lines of the event being read; when they pass 1 MiB the stream
/// fails.
public struct SSEParser: Sendable {
    public static let maxEventBytes = 1024 * 1024

    public enum Output: Equatable, Sendable {
        case event(SSEEvent)
        /// A `retry:` line: the wait before reconnecting, in milliseconds.
        case retry(Int)
    }

    private var line: [UInt8] = []
    private var lineEndedWithCR = false
    private var eventBytes = 0
    private var data: [UInt8] = []
    private var hasData = false
    private var type: String?
    private var lastEventID: String?

    public init() {}

    public mutating func feed(_ bytes: [UInt8]) throws -> [Output] {
        var outputs: [Output] = []
        var start = 0
        if lineEndedWithCR, bytes.first == 10 { start = 1 }
        lineEndedWithCR = false
        var index = start
        while index < bytes.count {
            let byte = bytes[index]
            if byte == 10 || byte == 13 {
                line.append(contentsOf: bytes[start..<index])
                try endLine(&outputs)
                if byte == 13 {
                    if index + 1 < bytes.count {
                        if bytes[index + 1] == 10 { index += 1 }
                    } else {
                        lineEndedWithCR = true
                    }
                }
                start = index + 1
            }
            index += 1
        }
        if start < bytes.count { line.append(contentsOf: bytes[start...]) }
        try checkSize()
        return outputs
    }

    private func checkSize() throws {
        if eventBytes + line.count > Self.maxEventBytes {
            throw HTTPError.malformedResponse("An event of the stream is larger than 1 MiB.")
        }
    }

    private mutating func endLine(_ outputs: inout [Output]) throws {
        let current = line
        line.removeAll(keepingCapacity: true)
        if current.isEmpty {
            dispatch(&outputs)
            return
        }
        if current[0] == 58 { return }
        eventBytes += current.count + 1
        try checkSize()
        let field: ArraySlice<UInt8>
        var value: ArraySlice<UInt8>
        if let colon = current.firstIndex(of: 58) {
            field = current[..<colon]
            value = current[(colon + 1)...]
            if value.first == 32 { value = value.dropFirst() }
        } else {
            field = current[...]
            value = []
        }
        switch String(decoding: field, as: UTF8.self) {
        case "data":
            data.append(contentsOf: value)
            data.append(10)
            hasData = true
        case "event":
            type = String(decoding: value, as: UTF8.self)
        case "id":
            if !value.contains(0) { lastEventID = String(decoding: value, as: UTF8.self) }
        case "retry":
            if !value.isEmpty, value.allSatisfy({ $0 >= 48 && $0 <= 57 }), let milliseconds = Int(String(decoding: value, as: UTF8.self)) {
                outputs.append(.retry(milliseconds))
            }
        default:
            break
        }
    }

    private mutating func dispatch(_ outputs: inout [Output]) {
        defer {
            data.removeAll(keepingCapacity: true)
            hasData = false
            type = nil
            eventBytes = 0
        }
        guard hasData else { return }
        data.removeLast()
        let eventType = type.flatMap { $0.isEmpty ? nil : $0 } ?? "message"
        outputs.append(.event(SSEEvent(id: lastEventID, type: eventType, data: String(decoding: data, as: UTF8.self))))
    }
}
