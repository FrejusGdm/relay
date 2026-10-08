/// A string value from the API that may gain new values within v1 (phase 5 decision 16). Unknown
/// strings decode to `.other` instead of failing, and the card shows them as "Unknown". Each type
/// writes its own `init(from:)`, so the compiler does not derive a keyed form for `.other`.
public protocol OpenEnum: Decodable, Equatable, Sendable {
    init(rawString: String)
    var rawString: String { get }
}

public enum AvailabilityStatus: OpenEnum {
    case available, rateLimited, quotaExhausted, unavailable, unknown
    case other(String)

    public init(from decoder: any Decoder) throws {
        self.init(rawString: try decoder.singleValueContainer().decode(String.self))
    }

    public init(rawString: String) {
        switch rawString {
        case "available": self = .available
        case "rate_limited": self = .rateLimited
        case "quota_exhausted": self = .quotaExhausted
        case "unavailable": self = .unavailable
        case "unknown": self = .unknown
        default: self = .other(rawString)
        }
    }

    public var rawString: String {
        switch self {
        case .available: "available"
        case .rateLimited: "rate_limited"
        case .quotaExhausted: "quota_exhausted"
        case .unavailable: "unavailable"
        case .unknown: "unknown"
        case .other(let value): value
        }
    }
}

public enum WorkerState: OpenEnum {
    case starting, running, stopped, ended
    case other(String)

    public init(from decoder: any Decoder) throws {
        self.init(rawString: try decoder.singleValueContainer().decode(String.self))
    }

    public init(rawString: String) {
        switch rawString {
        case "starting": self = .starting
        case "running": self = .running
        case "stopped": self = .stopped
        case "ended": self = .ended
        default: self = .other(rawString)
        }
    }

    public var rawString: String {
        switch self {
        case .starting: "starting"
        case .running: "running"
        case .stopped: "stopped"
        case .ended: "ended"
        case .other(let value): value
        }
    }
}

public enum WorkerMode: OpenEnum {
    case interactive, headless
    case other(String)

    public init(from decoder: any Decoder) throws {
        self.init(rawString: try decoder.singleValueContainer().decode(String.self))
    }

    public init(rawString: String) {
        switch rawString {
        case "interactive": self = .interactive
        case "headless": self = .headless
        default: self = .other(rawString)
        }
    }

    public var rawString: String {
        switch self {
        case .interactive: "interactive"
        case .headless: "headless"
        case .other(let value): value
        }
    }
}

public enum EndReason: OpenEnum {
    case exited, interrupted, stoppedBySwitch, relayStopped, startFailed
    case other(String)

    public init(from decoder: any Decoder) throws {
        self.init(rawString: try decoder.singleValueContainer().decode(String.self))
    }

    public init(rawString: String) {
        switch rawString {
        case "exited": self = .exited
        case "interrupted": self = .interrupted
        case "stopped_by_switch": self = .stoppedBySwitch
        case "relay_stopped": self = .relayStopped
        case "start_failed": self = .startFailed
        default: self = .other(rawString)
        }
    }

    public var rawString: String {
        switch self {
        case .exited: "exited"
        case .interrupted: "interrupted"
        case .stoppedBySwitch: "stopped_by_switch"
        case .relayStopped: "relay_stopped"
        case .startFailed: "start_failed"
        case .other(let value): value
        }
    }
}

public enum CheckpointKind: OpenEnum {
    case baseline, manual, preRollback, handoff, auto
    case other(String)

    public init(from decoder: any Decoder) throws {
        self.init(rawString: try decoder.singleValueContainer().decode(String.self))
    }

    public init(rawString: String) {
        switch rawString {
        case "baseline": self = .baseline
        case "manual": self = .manual
        case "pre_rollback": self = .preRollback
        case "handoff": self = .handoff
        case "auto": self = .auto
        default: self = .other(rawString)
        }
    }

    public var rawString: String {
        switch self {
        case .baseline: "baseline"
        case .manual: "manual"
        case .preRollback: "pre_rollback"
        case .handoff: "handoff"
        case .auto: "auto"
        case .other(let value): value
        }
    }
}
