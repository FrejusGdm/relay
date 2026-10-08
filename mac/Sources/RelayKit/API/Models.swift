import Foundation

// The JSON shapes of phase 5 design decision 14. Every field is present in the API's answers and
// unknown values are null; fields the daemon may leave null are optional here.

public struct VersionInfo: Decodable, Equatable, Sendable {
    public let api: String
    public let daemonVersion: String
    public let pid: Int32
    public let startedAt: Date
    public let capabilities: [String]
}

public struct Availability: Decodable, Equatable, Sendable {
    public let status: AvailabilityStatus
    public let reason: String?
    public let retryAt: Date?
    public let measuredAt: Date?
    public let source: String?
}

public struct UsageItem: Decodable, Equatable, Sendable {
    public let window: String
    public let windowMinutes: Int?
    public let usedPercent: Double?
    public let resetsAt: Date?
    public let measuredAt: Date?
}

public struct Account: Decodable, Equatable, Sendable {
    public let target: String
    public let provider: String
    public let providerName: String
    public let account: String
    public let configured: Bool
    public let availability: Availability
    public let usage: [UsageItem]
}

public struct Checkpoint: Decodable, Equatable, Sendable {
    public let number: Int
    public let commit: String
    public let ref: String
    public let kind: CheckpointKind
    public let createdAt: Date
    public let message: String?
}

public struct Worker: Decodable, Equatable, Sendable {
    public let id: String
    public let jobId: String
    public let target: String
    public let mode: WorkerMode
    public let state: WorkerState
    public let pid: Int32?
    public let providerSessionId: String?
    public let fromHandoff: Bool
    public let startedAt: Date?
    public let endedAt: Date?
    public let exitCode: Int?
    public let endReason: EndReason?
}

public struct Job: Decodable, Equatable, Sendable {
    public let id: String
    public let title: String?
    public let state: String?
    public let projectRoot: String
    public let projectMissing: Bool
    public let currentWorker: Worker?
    public let lastCheckpoint: Checkpoint?
    public let updatedAt: Date
}

/// The data of an `availability` event. It decodes both shapes phase 5 describes: a whole
/// `Account`, and `{"target", "availability"}` (design.md decision 7).
public struct AvailabilityChange: Decodable, Equatable, Sendable {
    public let target: String
    public let availability: Availability
    public let usage: [UsageItem]?
}

/// The data of a `checkpoint` event.
public struct CheckpointChange: Decodable, Equatable, Sendable {
    public let jobId: String
    public let checkpoint: Checkpoint
}

/// Data read with a `GET`, with the snapshot number from the `Relay-Stream-Seq` header, or `nil`
/// when the header is absent or not a whole number (design.md decision 7).
public struct Snapshot<Value: Sendable>: Sendable {
    public let value: Value
    public let streamSeq: Int?
}

extension Snapshot: Equatable where Value: Equatable {}
