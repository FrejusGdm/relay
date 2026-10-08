import Foundation

/// Text made of runs, so the views can set the monospace and accent parts without rules of their
/// own.
public struct StyledText: Equatable, Sendable {
    public enum Style: Equatable, Sendable {
        case plain
        /// The first part of the status line: accent color, semibold.
        case strong
        /// IBM Plex Mono: hashes, job IDs, times, paths and commands.
        case mono
        case muted
        /// IBM Plex Mono in the muted color.
        case mutedMono
    }

    public struct Run: Equatable, Sendable {
        public let text: String
        public let style: Style

        static func plain(_ text: String) -> Run { Run(text: text, style: .plain) }
        static func mono(_ text: String) -> Run { Run(text: text, style: .mono) }
    }

    public let runs: [Run]

    public init(_ runs: [Run]) {
        self.runs = runs
    }

    public var plain: String {
        runs.map(\.text).joined()
    }

    static func text(_ text: String) -> StyledText { StyledText([Run(text: text, style: .plain)]) }
    static func strong(_ lead: String, _ rest: [Run] = []) -> StyledText {
        StyledText([Run(text: lead, style: .strong)] + (rest.isEmpty ? [] : [Run(text: " · ", style: .plain)] + rest))
    }
}

/// The colors a piece of card text may take; every one comes with words (`DESIGN.md`, rule 6).
public enum Tone: Equatable, Sendable {
    case plain
    case accent
    case warning
}

/// Account availability in words (phase 5 decision 19; design.md decision 8).
public struct AvailabilityWords: Equatable, Sendable {
    /// "Available", "Limit reached", "Out of quota", "Unavailable" or "Unknown".
    public let word: String
    /// The word with the reset time, for example "Limit · resets 18:00", the time in monospace.
    public let detail: StyledText
    /// Whether the account cannot take work now; the views use the warning color.
    public let isWarning: Bool
    /// A limit whose reset time has passed without a new report.
    public let isStale: Bool
}

/// Times and names as the card writes them (design.md decision 8).
struct CardWords {
    let now: Date
    let calendar: Calendar
    let locale: Locale

    /// "18:00" today, "Thu 09:00" within six days, otherwise "12 Oct, 09:00" (the day and month in
    /// the locale's order, and the locale's 12- or 24-hour clock).
    func time(_ date: Date) -> String {
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        if calendar.isDate(date, inSameDayAs: now) {
            return date.formatted(style.hour().minute())
        }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? Int.max
        if abs(days) <= 6 {
            return date.formatted(style.weekday(.abbreviated).hour().minute())
        }
        return date.formatted(style.month(.abbreviated).day()) + ", " + date.formatted(style.hour().minute())
    }

    func availability(_ availability: Availability) -> AvailabilityWords {
        let limited = availability.status == .rateLimited || availability.status == .quotaExhausted
        if limited, let retryAt = availability.retryAt, retryAt < now {
            return AvailabilityWords(word: "Unknown", detail: .text("Unknown · reset time passed"), isWarning: false, isStale: true)
        }
        func withReset(_ lead: String) -> StyledText {
            guard let retryAt = availability.retryAt else { return .text(lead + " · reset unknown") }
            return StyledText([.plain(lead + " · resets "), .mono(time(retryAt))])
        }
        switch availability.status {
        case .available:
            return AvailabilityWords(word: "Available", detail: .text("Available"), isWarning: false, isStale: false)
        case .rateLimited:
            return AvailabilityWords(word: "Limit reached", detail: withReset("Limit"), isWarning: true, isStale: false)
        case .quotaExhausted:
            return AvailabilityWords(word: "Out of quota", detail: withReset("Out of quota"), isWarning: true, isStale: false)
        case .unavailable:
            return AvailabilityWords(word: "Unavailable", detail: .text("Unavailable"), isWarning: true, isStale: false)
        case .unknown, .other:
            return AvailabilityWords(word: "Unknown", detail: .text("Unknown"), isWarning: false, isStale: false)
        }
    }

    /// "9% used · 5-hour window · checked 14:30", for one account's narrowest window.
    func usage(_ items: [UsageItem]) -> UsageLine? {
        let narrowest = items.filter { $0.usedPercent != nil }.min { ($0.windowMinutes ?? Int.max) < ($1.windowMinutes ?? Int.max) }
        guard let item = narrowest, let percent = item.usedPercent else { return nil }
        var runs = [StyledText.Run.plain("\(Int(percent.rounded()))% used · " + Self.window(item))]
        if let measuredAt = item.measuredAt { runs += [.plain(" · checked "), .mono(time(measuredAt))] }
        return UsageLine(fraction: min(max(percent / 100, 0), 1), text: StyledText(runs))
    }

    private static func window(_ item: UsageItem) -> String {
        guard let minutes = item.windowMinutes, minutes > 0 else {
            return item.window.replacingOccurrences(of: "_", with: " ") + " window"
        }
        if minutes % 1440 == 0 { return "\(minutes / 1440)-day window" }
        if minutes % 60 == 0 { return "\(minutes / 60)-hour window" }
        return "\(minutes)-minute window"
    }

    static func providerName(target: String, accounts: [String: Account]) -> String {
        if let name = accounts[target]?.providerName, !name.isEmpty { return name }
        let provider = String(target.split(separator: ":", maxSplits: 1).first ?? "")
        switch provider {
        case "claude": return "Claude Code"
        case "codex": return "Codex"
        default: return provider
        }
    }

    /// `codex:personal` gives "Personal account".
    static func accountLine(target: String) -> String {
        let parts = target.split(separator: ":", maxSplits: 1)
        guard parts.count == 2 else { return target }
        return parts[1].prefix(1).uppercased() + parts[1].dropFirst() + " account"
    }

    static func workerWords(_ worker: Worker) -> String {
        switch (worker.state, worker.endReason) {
        case (.running, _): return "Working"
        case (.starting, _): return "Starting"
        case (.stopped, _): return "Stopped"
        case (.ended, .stoppedBySwitch): return "Handed off"
        case (.ended, .exited): return "Finished"
        case (.ended, _): return "Ended"
        case (.other, _): return "Unknown"
        }
    }
}
