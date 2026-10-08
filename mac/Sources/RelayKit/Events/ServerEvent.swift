/// One event of `GET /v1/events`, with its data decoded (design.md decision 7, the table of event
/// types).
public struct ServerEvent: Equatable, Sendable {
    public enum Payload: Equatable, Sendable {
        case job(Job)
        case worker(Worker)
        case checkpoint(CheckpointChange)
        case availability(AvailabilityChange)
        case reset
        case shutdown
        /// The wait before reconnecting that the stream asked for.
        case retry(milliseconds: Int)
        /// A comment line such as `: ping`, which shows the stream is alive.
        case keepAlive
        /// A `hook` event, a type this app does not know, or data that did not decode. Its `id`
        /// still moves the app's place in the stream.
        case ignored(type: String)
    }

    /// The event's `id`, which is the daemon's `stream_events.seq`.
    public let id: Int?
    public let payload: Payload

    public init(id: Int?, payload: Payload) {
        self.id = id
        self.payload = payload
    }

    init(_ output: SSEParser.Output) {
        switch output {
        case .retry(let milliseconds):
            self.init(id: nil, payload: .retry(milliseconds: milliseconds))
        case .comment:
            self.init(id: nil, payload: .keepAlive)
        case .event(let event):
            let id = event.id.flatMap { text in
                !text.isEmpty && text.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) ? Int(text) : nil
            }
            self.init(id: id, payload: Self.payload(type: event.type, data: Array(event.data.utf8)))
        }
    }

    private static func payload(type: String, data: [UInt8]) -> Payload {
        do {
            switch type {
            case "job": return .job(try APIDecoder.decode(Job.self, from: data))
            case "worker": return .worker(try APIDecoder.decode(Worker.self, from: data))
            case "checkpoint": return .checkpoint(try APIDecoder.decode(CheckpointChange.self, from: data))
            case "availability": return .availability(try APIDecoder.decode(AvailabilityChange.self, from: data))
            case "reset": return .reset
            case "shutdown": return .shutdown
            default: return .ignored(type: type)
            }
        } catch {
            return .ignored(type: type)
        }
    }
}
