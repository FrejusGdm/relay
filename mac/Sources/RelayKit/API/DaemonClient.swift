import Darwin
import Foundation

public enum ClientError: Error, Equatable, Sendable {
    case invalidJobID(String)
    case invalidTarget(String)
    /// `GET /v1/version` does not offer API v1 with `accounts`, `jobs` and `events.sse`.
    case incompatibleDaemon
}

/// The app's client of relay's local API (design.md decisions 4 to 7). It talks only to the Unix
/// socket of `location` and only to a daemon running as `expectedUID`.
public struct DaemonClient: Sendable {
    public static let requestTimeout = 2.0
    public static let streamInactivityLimit = 45.0
    static let requiredCapabilities = ["accounts", "jobs", "events.sse"]

    let transport: HTTPTransport
    let userAgent: String

    public init(
        location: SocketLocation,
        clock: any RelayClock = SystemClock(),
        expectedUID: uid_t = getuid(),
        appVersion: String = DaemonClient.bundleVersion
    ) {
        transport = HTTPTransport(location: location, expectedUID: expectedUID, clock: clock)
        userAgent = "relay-mac/\(appVersion)"
    }

    public static var bundleVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    }

    public func version() async throws -> Snapshot<VersionInfo> {
        try await get("/v1/version", as: VersionInfo.self)
    }

    /// `version()`, failing with `incompatibleDaemon` when the daemon lacks what the app needs.
    public func checkedVersion() async throws -> Snapshot<VersionInfo> {
        let snapshot = try await version()
        let info = snapshot.value
        guard info.api == "v1", Self.requiredCapabilities.allSatisfy({ info.capabilities.contains($0) }) else {
            throw ClientError.incompatibleDaemon
        }
        return snapshot
    }

    public func accounts() async throws -> Snapshot<[Account]> {
        struct Body: Decodable, Sendable { let accounts: [Account] }
        let snapshot = try await get("/v1/accounts", as: Body.self)
        return Snapshot(value: snapshot.value.accounts, streamSeq: snapshot.streamSeq)
    }

    public func jobs() async throws -> Snapshot<[Job]> {
        struct Body: Decodable, Sendable { let jobs: [Job] }
        let snapshot = try await get("/v1/jobs", as: Body.self)
        return Snapshot(value: snapshot.value.jobs, streamSeq: snapshot.streamSeq)
    }

    public func job(_ id: String) async throws -> Snapshot<Job> {
        guard RelayID.isJobID(id) else { throw ClientError.invalidJobID(id) }
        struct Body: Decodable, Sendable { let job: Job }
        let snapshot = try await get("/v1/jobs/\(id)", as: Body.self)
        return Snapshot(value: snapshot.value.job, streamSeq: snapshot.streamSeq)
    }

    public func workers(jobID: String) async throws -> Snapshot<[Worker]> {
        guard RelayID.isJobID(jobID) else { throw ClientError.invalidJobID(jobID) }
        struct Body: Decodable, Sendable { let workers: [Worker] }
        let snapshot = try await get("/v1/jobs/\(jobID)/workers", as: Body.self)
        return Snapshot(value: snapshot.value.workers, streamSeq: snapshot.streamSeq)
    }

    private func get<T: Decodable & Sendable>(_ path: String, as type: T.Type) async throws -> Snapshot<T> {
        let request = HTTPRequest.get(path).serialized(userAgent: userAgent)
        let transport = self.transport
        let response = try await Self.runBlocking {
            try transport.send(request, timeout: Self.requestTimeout)
        }
        guard (200..<300).contains(response.head.status) else { throw APIError.decode(response) }
        let value: T
        do {
            value = try APIDecoder.decode(T.self, from: response.body)
        } catch {
            throw HTTPError.malformedResponse("The answer to \(path) did not decode: \(error)")
        }
        return Snapshot(value: value, streamSeq: Self.streamSeq(response.head))
    }

    static func streamSeq(_ head: HTTPResponseHead) -> Int? {
        guard let text = head.value("Relay-Stream-Seq"), !text.isEmpty,
              text.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 })
        else { return nil }
        return Int(text)
    }

    /// Runs a blocking call on its own serial queue (design.md decision 4).
    static func runBlocking<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue(label: "io.github.frejusgdm.relay.request").async {
                continuation.resume(with: Result { try work() })
            }
        }
    }
}
