import Foundation
@testable import RelayKit
import RelayTestSupport
import Testing

/// A store following a fake daemon, with a clock the test moves.
@MainActor
final class StoreHarness {
    let fake: FakeDaemon
    let clock = FixedClock()
    let store: RelayStore
    private var task: Task<Void, Never>?

    init(location: SocketLocation? = nil, configure: (FakeDaemon) -> Void = { _ in }) throws {
        fake = try FakeDaemon()
        fake.reply("GET", "/v1/accounts", with: .fixture("GET_v1_accounts.json"))
        fake.reply("GET", "/v1/jobs", with: .fixture("GET_v1_jobs.handoff.json"))
        fake.reply("GET", "/v1/jobs/3f9a2c1d/workers", with: .fixture("GET_v1_jobs_3f9a2c1d_workers.handoff.json"))
        fake.reply("GET", "/v1/events", with: .newFeedPerRequest)
        configure(fake)
        store = RelayStore(client: DaemonClient(location: location ?? fake.location, clock: clock), clock: clock)
    }

    func start() {
        task = Task { await store.run() }
    }

    /// Starts the store and waits until its first event stream is open and healthy.
    func connect() async throws -> EventFeed {
        start()
        let feed = try await feed(1)
        feed.push("retry: 1000\n\n")
        try await until { self.store.streamIsHealthy }
        return feed
    }

    /// The `index`-th event stream (from 1), once the store has opened it.
    func feed(_ index: Int) async throws -> EventFeed {
        try await until { self.fake.openedFeeds.count >= index }
        return fake.openedFeeds[index - 1]
    }

    /// Waits up to 5 seconds of real time for `condition`.
    func until(_ condition: () -> Bool, sourceLocation: SourceLocation = #_sourceLocation) async throws {
        for _ in 0..<500 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        Issue.record("Condition not met within 5 seconds", sourceLocation: sourceLocation)
        throw CancellationError()
    }

    /// Moves the clock in small steps, giving the store real time to act after each one.
    func advance(by seconds: Double, step: Double = 0.25) async throws {
        var moved = 0.0
        while moved < seconds {
            clock.advance(by: step)
            moved += step
            try await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    func push(_ feed: EventFeed, id: Int, _ type: String, _ data: Any) {
        feed.push("id: \(id)\nevent: \(type)\ndata: \(Sample.text(data))\n\n")
    }

    func card() -> CardModel {
        CardModel.make(store.cardInput(), now: clock.now, calendar: Sample.calendar, locale: Sample.locale)
    }

    func finish() {
        task?.cancel()
        #expect(fake.requests.allSatisfy { $0.method == "GET" }, "The store sent a request other than GET.")
        fake.stop()
    }
}

@MainActor
@Suite(.timeLimit(.minutes(1)))
struct StoreTests {
    @Test func availabilityEventUpdatesOneAccount() async throws {
        let harness = try StoreHarness()
        defer { harness.finish() }
        let feed = try await harness.connect()
        let before = harness.fake.requests.count
        let others = harness.store.accountsByTarget.filter { $0.key != "claude:personal" }
        let account = Sample.accountJSON(target: "claude:personal", status: "rate_limited", measuredAt: "2026-10-07T14:40:00.000Z")
        harness.push(feed, id: 10, "availability", account)
        try await harness.until { harness.store.accountsByTarget["claude:personal"]?.availability.status == .rateLimited }
        #expect(harness.store.accountsByTarget.filter { $0.key != "claude:personal" } == others)
        #expect(harness.fake.requests.count == before)
    }

    @Test func olderJobEventAfterANewerSnapshotIsIgnored() async throws {
        let harness = try StoreHarness()
        defer { harness.finish() }
        let feed = try await harness.connect()
        harness.push(feed, id: 11, "job", Sample.jobJSON(title: "Old title", updatedAt: "2026-10-07T14:00:00.000Z"))
        try await harness.until { harness.store.cursor == 11 }
        #expect(harness.store.jobsByID["3f9a2c1d"]?.title == "Build authentication")
    }

    @Test(arguments: [4180, nil] as [Int?])
    func replayedRunningWorkerStaysStopped(streamSeq: Int?) async throws {
        let stopped = Sample.workerJSON(state: "stopped")
        let harness = try StoreHarness { fake in
            fake.reply("GET", "/v1/accounts", with: .fixture("GET_v1_accounts.json", streamSeq: streamSeq))
            fake.reply("GET", "/v1/jobs", with: .json(Sample.text(["jobs": [Sample.jobJSON(current: stopped)]]), streamSeq: streamSeq))
            fake.reply("GET", "/v1/jobs/3f9a2c1d/workers", with: .json(
                Sample.text(["workers": [stopped, Sample.previousWorkerJSON()]]), streamSeq: streamSeq
            ))
        }
        defer { harness.finish() }
        let feed = try await harness.connect()
        harness.push(feed, id: 4100, "worker", Sample.workerJSON())
        try await harness.until { harness.store.cursor == 4100 }
        #expect(harness.store.workersByJob["3f9a2c1d"]?.first?.state == .stopped)
        #expect(harness.store.jobsByID["3f9a2c1d"]?.currentWorker?.state == .stopped)
        guard case .job(let card) = harness.card() else {
            Issue.record("Expected a job card")
            return
        }
        #expect(card.status.plain == "Codex stopped · relay did not record why")
    }

    @Test func eventNewerThanTheSnapshotApplies() async throws {
        let harness = try StoreHarness { fake in
            fake.reply("GET", "/v1/jobs", with: .fixture("GET_v1_jobs.handoff.json", streamSeq: 4180))
            fake.reply("GET", "/v1/jobs/3f9a2c1d/workers", with: .fixture("GET_v1_jobs_3f9a2c1d_workers.handoff.json", streamSeq: 4180))
        }
        defer { harness.finish() }
        let feed = try await harness.connect()
        let ended = Sample.workerJSON(state: "ended", endedAt: "2026-10-07T14:50:00.000Z", endReason: "exited", exitCode: 0)
        harness.push(feed, id: 4181, "worker", ended)
        try await harness.until { harness.store.workersByJob["3f9a2c1d"]?.first?.state == .ended }
        #expect(harness.store.jobsByID["3f9a2c1d"]?.currentWorker?.state == .ended)
    }

    @Test func restartedDaemonGetsNoLastEventID() async throws {
        let harness = try StoreHarness()
        defer { harness.finish() }
        let first = try await harness.connect()
        harness.push(first, id: 4180, "job", Sample.jobJSON())
        try await harness.until { harness.store.cursor == 4180 }

        harness.fake.setVersion(pid: 5120, startedAt: "2026-10-07T15:00:00.000Z")
        first.close()
        while harness.fake.openedFeeds.count < 2 { try await harness.advance(by: 0.5) }
        let second = try await harness.feed(2)
        #expect(harness.fake.requests("GET", "/v1/events").last?.headers["last-event-id"] == nil)

        let ended = Sample.workerJSON(state: "ended", endedAt: "2026-10-07T15:01:00.000Z", endReason: "exited", exitCode: 0)
        harness.push(second, id: 3, "worker", ended)
        try await harness.until { harness.store.cursor == 3 }
        #expect(harness.store.workersByJob["3f9a2c1d"]?.first?.state == .ended)
    }

    @Test func sameDaemonResumesWithLastEventIDAndReloads() async throws {
        let harness = try StoreHarness()
        defer { harness.finish() }
        let first = try await harness.connect()
        harness.push(first, id: 4180, "job", Sample.jobJSON())
        try await harness.until { harness.store.cursor == 4180 }
        first.close()
        while harness.fake.openedFeeds.count < 2 { try await harness.advance(by: 0.5) }
        #expect(harness.fake.requests("GET", "/v1/events").last?.headers["last-event-id"] == "4180")
        try await harness.until { harness.fake.requests("GET", "/v1/jobs").count == 2 }
        #expect(harness.fake.requests("GET", "/v1/accounts").count == 2)
    }

    @Test func resetReloadsEverything() async throws {
        let harness = try StoreHarness()
        defer { harness.finish() }
        let feed = try await harness.connect()
        feed.push("id: 12\nevent: reset\ndata: {}\n\n")
        try await harness.until {
            harness.fake.requests("GET", "/v1/accounts").count == 2 && harness.fake.requests("GET", "/v1/jobs").count == 2
        }
    }

    @Test func shutdownMeansNotRunning() async throws {
        let harness = try StoreHarness()
        defer { harness.finish() }
        let feed = try await harness.connect()
        feed.push("event: shutdown\ndata: {}\n\n")
        feed.close()
        try await harness.until { harness.store.connection == .notRunning }
        #expect(harness.card().accessibilityLabel == "relay: relay is not running")
    }

    @Test func silentStreamIsReopened() async throws {
        let harness = try StoreHarness()
        defer { harness.finish() }
        _ = try await harness.connect()
        harness.clock.advance(by: 46)
        while harness.fake.openedFeeds.count < 2 { try await harness.advance(by: 0.5) }
        #expect(harness.fake.requests("GET", "/v1/events").count == 2)
    }

    @Test func retryWaitIsCappedAtOneMinute() async throws {
        let harness = try StoreHarness()
        defer { harness.finish() }
        let feed = try await harness.connect()
        feed.push("retry: 3600000\n\n")
        feed.push(": ping\n\n")
        try await Task.sleep(nanoseconds: 100_000_000)
        feed.close()
        try await harness.until { harness.clock.waitingCount == 2 }
        try await harness.advance(by: 59, step: 1)
        #expect(harness.fake.openedFeeds.count == 1)
        try await harness.advance(by: 2, step: 0.5)
        try await harness.until { harness.fake.openedFeeds.count == 2 }
    }

    @Test func atMostSevenAttemptsAMinuteWithoutASocket() async throws {
        let home = try makeTemporaryFolder()
        defer { try? FileManager.default.removeItem(atPath: home) }
        let harness = try StoreHarness(location: SocketLocation(home: home + "/missing"))
        defer { harness.finish() }
        harness.start()
        try await harness.until { harness.store.connection == .notRunning }
        try await harness.advance(by: 60)
        #expect(harness.store.cycleCount >= 5)
        #expect(harness.store.cycleCount <= 7)
    }

    @Test func refusedStreamIsRetriedAtMostSevenTimesAMinute() async throws {
        let harness = try StoreHarness { fake in
            fake.reply("GET", "/v1/events", with: .json(
                #"{"error":{"code":"shutting_down","message":"The relay daemon is stopping."}}"#, status: 503
            ))
        }
        defer { harness.finish() }
        harness.start()
        try await harness.until { harness.fake.requests("GET", "/v1/events").count == 1 }
        try await harness.advance(by: 60)
        let streams = harness.fake.requests("GET", "/v1/events").count
        #expect(streams >= 4)
        #expect(streams <= 7)
    }

    @Test func refreshShowsAWorkerThatDisappeared() async throws {
        let harness = try StoreHarness()
        defer { harness.finish() }
        let feed = try await harness.connect()
        harness.store.windowOpened()
        try await harness.until {
            harness.fake.requests("GET", "/v1/jobs/3f9a2c1d/workers").count == 2 && harness.clock.waitingCount == 2
        }

        let stopped = Sample.workerJSON(state: "stopped")
        harness.fake.reply("GET", "/v1/jobs", with: .json(Sample.text(["jobs": [Sample.jobJSON(current: stopped)]])))
        harness.fake.reply("GET", "/v1/jobs/3f9a2c1d/workers", with: .json(Sample.text(["workers": [stopped, Sample.previousWorkerJSON()]])))
        for _ in 0..<2 {
            harness.clock.advance(by: 15)
            feed.push(": ping\n\n")
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        try await harness.until {
            if case .job(let card) = harness.card() { return card.status.plain == "Codex stopped · relay did not record why" }
            return false
        }
        #expect(harness.store.streamIsHealthy)
        #expect(harness.fake.requests("GET", "/v1/events").count == 1)
    }

    @Test func closedWindowRefreshesEveryFiveMinutes() async throws {
        let harness = try StoreHarness()
        defer { harness.finish() }
        let feed = try await harness.connect()
        for _ in 0..<40 {
            harness.clock.advance(by: 15)
            feed.push(": ping\n\n")
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        let refreshes = harness.fake.requests("GET", "/v1/jobs").count - 1
        #expect(refreshes <= 2)
        #expect(harness.fake.requests("GET", "/v1/events").count == 1)
    }
}
