/// A request in the HTTP/1.1 subset the daemon accepts (design.md decision 5). The app never sends
/// `Origin`, `Cookie`, `Authorization` or `Transfer-Encoding`.
public struct HTTPRequest: Equatable, Sendable {
    public enum Method: String, Sendable {
        case get = "GET"
        case post = "POST"
    }

    public let method: Method
    public let path: String
    public let accept: String
    public let lastEventID: Int?
    public let body: [UInt8]?

    public static func get(_ path: String) -> HTTPRequest {
        HTTPRequest(method: .get, path: path, accept: "application/json", lastEventID: nil, body: nil)
    }

    public static func post(_ path: String, json body: [UInt8]) -> HTTPRequest {
        HTTPRequest(method: .post, path: path, accept: "application/json", lastEventID: nil, body: body)
    }

    public static func events(lastEventID: Int?) -> HTTPRequest {
        HTTPRequest(method: .get, path: "/v1/events", accept: "text/event-stream", lastEventID: lastEventID, body: nil)
    }

    public func serialized(userAgent: String) -> [UInt8] {
        var head = "\(method.rawValue) \(path) HTTP/1.1\r\n"
        head += "Host: relay\r\n"
        head += "Accept: \(accept)\r\n"
        head += "User-Agent: \(userAgent)\r\n"
        if let lastEventID { head += "Last-Event-ID: \(lastEventID)\r\n" }
        if let body {
            head += "Content-Type: application/json\r\n"
            head += "Content-Length: \(body.count)\r\n"
        }
        head += "\r\n"
        return Array(head.utf8) + (body ?? [])
    }
}
