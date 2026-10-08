import Foundation
@testable import RelayKit
import RelayTestSupport
import Testing

/// The card text of design.md decisions 8 and 9, in `en_GB`, UTC, at 2026-10-07 14:36 (a
/// Wednesday).
struct CardModelTests {
    func jobCard(_ input: CardInput, now: Date = FixedClock().now) throws -> JobCard {
        guard case .job(let card) = Sample.card(input, now: now) else {
            throw CardError.notAJob
        }
        return card
    }

    enum CardError: Error { case notAJob }

    // MARK: The status line table

    @Test func statusMovedAfterALimit() throws {
        let card = try jobCard(Sample.handoff())
        #expect(card.status.plain == "Moved to Codex · Claude Code reached its limit")
        #expect(card.status.runs.first == StyledText.Run(text: "Moved to Codex", style: .strong))
    }

    @Test func statusMovedFromAnotherAgent() throws {
        let input = try Sample.input(
            jobs: [Sample.jobJSON()],
            workers: [Sample.workerJSON(), Sample.previousWorkerJSON()],
            accounts: [Sample.accountJSON(target: "claude:work"), Sample.accountJSON(target: "codex:personal")]
        )
        #expect(try jobCard(input).status.plain == "Moved to Codex · from Claude Code")
        let alone = try Sample.input(jobs: [Sample.jobJSON()], workers: [Sample.workerJSON()])
        #expect(try jobCard(alone).status.plain == "Moved to Codex")
    }

    @Test func statusWorking() throws {
        let worker = Sample.workerJSON(fromHandoff: false)
        let input = try Sample.input(jobs: [Sample.jobJSON(current: worker)], workers: [worker])
        #expect(try jobCard(input).status.plain == "Codex is working")
    }

    @Test func statusStarting() throws {
        let worker = Sample.workerJSON(state: "starting", pid: nil, fromHandoff: false)
        let input = try Sample.input(jobs: [Sample.jobJSON(current: worker)], workers: [worker])
        #expect(try jobCard(input).status.plain == "Starting Codex")
    }

    @Test func statusStopped() throws {
        let worker = Sample.workerJSON(state: "stopped")
        let input = try Sample.input(jobs: [Sample.jobJSON(current: worker)], workers: [worker, Sample.previousWorkerJSON()])
        #expect(try jobCard(input).status.plain == "Codex stopped · relay did not record why")
    }

    @Test func statusLimitWithoutAWorker() throws {
        let limited = try Sample.input(
            jobs: [Sample.jobJSON(current: nil)],
            workers: [Sample.previousWorkerJSON()],
            accounts: [Sample.accountJSON(target: "claude:work", status: "rate_limited", retryAt: "2026-10-07T18:00:00.000Z")]
        )
        #expect(try jobCard(limited).status.plain == "Limit reached · Claude Code resets 18:00")
        let unknownReset = try Sample.input(
            jobs: [Sample.jobJSON(current: nil)],
            workers: [Sample.previousWorkerJSON()],
            accounts: [Sample.accountJSON(target: "claude:work", status: "rate_limited")]
        )
        #expect(try jobCard(unknownReset).status.plain == "Limit reached · Claude Code reset unknown")
    }

    @Test func statusNoAgent() throws {
        let input = try Sample.input(
            jobs: [Sample.jobJSON(current: nil)],
            workers: [Sample.previousWorkerJSON()],
            accounts: [Sample.accountJSON(target: "claude:work")]
        )
        let card = try jobCard(input)
        #expect(card.status.plain == "No agent is working on this job")
        #expect(card.rows.map(\.role) == ["Last worker"])
        #expect(card.rows.first?.state.plain == "Handed off")
    }

    // MARK: The availability table

    @Test(arguments: [
        ("available", nil as String?, "Available", "Available"),
        ("rate_limited", "2026-10-07T18:00:00.000Z", "Limit reached", "Limit · resets 18:00"),
        ("rate_limited", nil, "Limit reached", "Limit · reset unknown"),
        ("quota_exhausted", "2026-10-20T09:00:00.000Z", "Out of quota", "Out of quota · resets 20 Oct, 09:00"),
        ("quota_exhausted", nil, "Out of quota", "Out of quota · reset unknown"),
        ("unavailable", nil, "Unavailable", "Unavailable"),
        ("unknown", nil, "Unknown", "Unknown"),
        ("rate_limited", "2026-10-07T14:35:00.000Z", "Unknown", "Unknown · reset time passed"),
        ("paused", nil, "Unknown", "Unknown"),
    ])
    func availabilityWords(status: String, retryAt: String?, word: String, detail: String) throws {
        let account = try Sample.decode(Account.self, Sample.accountJSON(target: "claude:work", status: status, retryAt: retryAt))
        let words = CardWords(now: FixedClock().now, calendar: Sample.calendar, locale: Sample.locale).availability(account.availability)
        #expect(words.word == word)
        #expect(words.detail.plain == detail)
    }

    @Test func timesWithinADayAWeekAndLater() {
        let words = CardWords(now: FixedClock().now, calendar: Sample.calendar, locale: Sample.locale)
        let at = { (text: String) in ISO8601DateFormatter().date(from: text)! }
        #expect(words.time(at("2026-10-07T18:00:00Z")) == "18:00")
        #expect(words.time(at("2026-10-08T09:00:00Z")) == "Thu 09:00")
        #expect(words.time(at("2026-10-20T09:00:00Z")) == "20 Oct, 09:00")
    }

    // MARK: The state table

    @Test func statesWithoutAJob() throws {
        let cases: [(ConnectionState, String, String, String?)] = [
            (.connecting, "relay", "Connecting to relay…", nil),
            (.notRunning, "relay is not running", "Start it in a terminal: relay daemon start", "relay daemon start"),
            (.refused(.folderNotPrivate("/h/run")), "relay will not connect",
             "/h/run must be private (mode 0700, owned by you). Fix it with: chmod 700 /h/run", "chmod 700 /h/run"),
            (.refused(.folderIsSymbolicLink("/h/run")), "relay will not connect", "/h/run is a symbolic link. relay only uses a real folder.", nil),
            (.refused(.notASocket("/h/run/relay.sock")), "relay will not connect", "/h/run/relay.sock exists and is not a socket.", nil),
            (.refused(.peerIsAnotherUser), "relay will not connect", "The relay socket belongs to another user.", nil),
            (.refused(.pathTooLong("/h/run/relay.sock")), "relay will not connect",
             "The socket path /h/run/relay.sock is too long. Set RELAY_HOME to a shorter path.", nil),
            (.tooOld, "This relay is too old for this app", "Update relay, then run: relay daemon restart", "relay daemon restart"),
            (.connected, "No jobs yet", "Run relay init in a project to start one.", nil),
        ]
        for (connection, title, text, command) in cases {
            let input = try Sample.input(connection: connection, jobs: [])
            guard case .state(let card) = Sample.card(input) else {
                Issue.record("Expected a state card for \(connection)")
                continue
            }
            #expect(card.title == title)
            #expect(card.message.plain == text)
            #expect(card.command == command)
        }
        let notRunning = try Sample.input(connection: .notRunning, jobs: [])
        #expect(Sample.card(notRunning).accessibilityLabel == "relay: relay is not running")
    }

    // MARK: Other rules

    @Test func runningJobWinsOverANewerIdleJob() throws {
        let running = Sample.jobJSON(id: "aaaaaaaa", updatedAt: "2026-10-07T14:00:00.000Z")
        let idle = Sample.jobJSON(id: "bbbbbbbb", current: nil, updatedAt: "2026-10-07T14:30:00.000Z")
        #expect(try jobCard(Sample.input(jobs: [idle, running])).jobID == "aaaaaaaa")
        let bothIdle = Sample.jobJSON(id: "aaaaaaaa", current: nil, updatedAt: "2026-10-07T14:00:00.000Z")
        #expect(try jobCard(Sample.input(jobs: [bothIdle, idle])).jobID == "bbbbbbbb")
    }

    @Test func handoffCardRowsFactsAndActions() throws {
        let card = try jobCard(Sample.handoff())
        #expect(card.title == "Build authentication")
        #expect(card.repository.plain == "auth · 3f9a2c1d")
        #expect(card.repository.runs.last == StyledText.Run(text: "3f9a2c1d", style: .mono))
        #expect(card.rows.map(\.role) == ["Previous worker", "Current worker"])
        #expect(card.rows.map(\.providerName) == ["Claude Code", "Codex"])
        #expect(card.rows.map(\.account) == ["Work account", "Personal account"])
        #expect(card.rows.map(\.state.plain) == ["Limit · resets 19:00", "Working"])
        #expect(card.rows[0].state.runs.last == StyledText.Run(text: "19:00", style: .mono))
        #expect(card.rows.map(\.stateTone) == [.warning, .accent])
        #expect(card.connector?.title.plain == "Handed off · 14:36")
        #expect(card.connector?.detail == "Same repository & plan")
        #expect(card.facts.map(\.label) == ["Checkpoint", "Carried over"])
        #expect(card.facts[0].value.plain == "912ec1 · saved 14:35")
        #expect(card.facts[1].value.plain == "Repository, checkpoint & plan")
        #expect(card.tinyNote == "Same checkpoint & plan")
        #expect(card.primaryAction == .openHost(provider: "Codex", app: "Terminal", pid: Sample.hostPID))
        #expect(card.primaryAction?.label == "Open Codex in Terminal")
        #expect(card.primaryAction?.tinyLabel == "Open Codex ↗")
        #expect(card.showsViewCheckpoint)
        #expect(card.showsSwitchWorker)
        #expect(Sample.card(try Sample.handoff()).accessibilityLabel == "relay: Moved to Codex · Claude Code reached its limit")
    }

    @Test func withoutAHostTheActionShowsTheProject() throws {
        let card = try jobCard(Sample.handoff(host: nil))
        #expect(card.primaryAction == .showInFinder(path: "/Users/dev/projects/auth"))
        #expect(card.primaryAction?.label == "Show project in Finder")
    }

    @Test func missingProject() throws {
        let input = try Sample.input(jobs: [Sample.jobJSON(projectMissing: true)], workers: [Sample.workerJSON()])
        let card = try jobCard(input)
        #expect(card.repository.plain == "Project folder not found")
        #expect(card.primaryAction == nil)
        #expect(!card.showsSwitchWorker)
    }

    @Test func oneWorkerHasNoConnectorAndNoCheckpointSaysSo() throws {
        let worker = Sample.workerJSON(fromHandoff: false)
        let input = try Sample.input(jobs: [Sample.jobJSON(current: worker, checkpoint: nil)], workers: [worker], capabilities: ["accounts", "jobs", "events.sse"])
        let card = try jobCard(input)
        #expect(card.rows.count == 1)
        #expect(card.connector == nil)
        #expect(card.facts.map(\.label) == ["Checkpoint"])
        #expect(card.facts[0].value.plain == "None yet")
        #expect(card.tinyNote == "No checkpoint yet")
        #expect(!card.showsViewCheckpoint)
        #expect(!card.showsSwitchWorker)
    }

    @Test func staleResetAndUsage() throws {
        let input = try Sample.input(
            jobs: [Sample.jobJSON()],
            workers: [Sample.workerJSON(), Sample.previousWorkerJSON()],
            accounts: [
                Sample.accountJSON(target: "claude:work", status: "rate_limited", retryAt: "2026-10-07T14:35:00.000Z"),
                Sample.accountJSON(target: "codex:personal"),
            ]
        )
        let card = try jobCard(input)
        #expect(card.rows[0].state.plain == "Unknown · reset time passed")
        #expect(card.status.plain == "Moved to Codex · from Claude Code")
        #expect(card.rows.allSatisfy { $0.usage == nil })

        let usage = try jobCard(Sample.handoff())
        #expect(usage.rows[1].usage?.text.plain == "9% used · 5-hour window · checked 14:30")
        #expect(usage.rows[1].usage?.fraction == 0.09)
        #expect(usage.rows[0].usage == nil)
    }

    @Test func percentagesBelongToOneAccount() throws {
        let input = try Sample.input(
            jobs: [Sample.jobJSON()],
            workers: [Sample.workerJSON(), Sample.previousWorkerJSON(target: "claude:home")],
            accounts: [
                Sample.accountJSON(target: "claude:home", usage: [Sample.usageJSON(percent: 41), Sample.usageJSON(percent: 12, minutes: 10080, window: "seven_day")]),
                Sample.accountJSON(target: "codex:personal", usage: [Sample.usageJSON(percent: 9)]),
            ]
        )
        let card = try jobCard(input)
        #expect(card.rows.map { $0.usage?.text.plain } == ["41% used · 5-hour window · checked 14:30", "9% used · 5-hour window · checked 14:30"])
        var texts = [card.title, card.repository.plain, card.status.plain, card.tinyNote]
        texts += card.rows.flatMap { [$0.providerName, $0.role, $0.account, $0.state.plain] }
        texts += card.facts.flatMap { [$0.label, $0.value.plain] }
        texts += [card.connector?.title.plain, card.connector?.detail, card.primaryAction?.label].compactMap { $0 }
        #expect(texts.allSatisfy { !$0.contains("%") })
    }
}
