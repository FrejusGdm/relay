import Foundation

/// The answer of `POST /v1/jobs/{job}/switch`. The `handoff` object is not used.
public struct SwitchResponse: Decodable, Equatable, Sendable {
    public let worker: Worker
}

extension DaemonClient {
    /// The engine may ask the outgoing agent for notes and run the job's checks (design.md
    /// decision 5).
    public static let switchTimeout = 15.0 * 60

    /// Sends one switch request. It is never repeated by the client.
    public func switchJob(_ id: String, target: String, confirmNewProvider: Bool) async throws -> SwitchResponse {
        guard RelayID.isJobID(id) else { throw ClientError.invalidJobID(id) }
        guard RelayID.isTarget(target) else { throw ClientError.invalidTarget(target) }
        // The target matches the pattern above, so it needs no JSON escaping.
        let body = Array(#"{"target":"\#(target)","confirm_new_provider":\#(confirmNewProvider)}"#.utf8)
        let request = HTTPRequest.post("/v1/jobs/\(id)/switch", json: body).serialized(userAgent: userAgent)
        let transport = self.transport
        let response = try await Self.runBlocking {
            try transport.send(request, timeout: Self.switchTimeout)
        }
        guard (200..<300).contains(response.head.status) else { throw APIError.decode(response) }
        do {
            return try APIDecoder.decode(SwitchResponse.self, from: response.body)
        } catch {
            throw HTTPError.malformedResponse("The answer to the switch did not decode: \(error)")
        }
    }
}
