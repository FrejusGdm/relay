import Foundation

/// The source of the current time. Tests pass a clock they move by hand (design.md decision 14).
public protocol RelayClock: Sendable {
    var now: Date { get }
}

public struct SystemClock: RelayClock {
    public init() {}

    public var now: Date { Date() }
}
