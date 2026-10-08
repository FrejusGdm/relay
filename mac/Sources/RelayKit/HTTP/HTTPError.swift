/// Failures of the HTTP layer (design.md decision 5).
public enum HTTPError: Error, Equatable, Sendable {
    /// The answer is not in the subset the daemon sends; the text says what was wrong.
    case malformedResponse(String)
    case responseTooLarge
    case timedOut
}

/// An error answer of the API: `{"error": {"code": "...", "message": "..."}}` with a status that is
/// not 2xx.
public struct APIError: Error, Equatable, Sendable {
    public let status: Int
    public let code: String
    public let message: String

    public init(status: Int, code: String, message: String) {
        self.status = status
        self.code = code
        self.message = message
    }
}
