import AppKit
import Foundation
import RelayKit
import RelayTestSupport
import RelayUI
import Testing

@MainActor
@Suite(.timeLimit(.minutes(1)))
struct LinkWindowTests {
    @Test func linksOpenOneWindowPerJobAndSendOnlyGET() async throws {
        _ = NSApplication.shared
        let fake = try FakeDaemon()
        defer { fake.stop() }
        fake.reply("GET", "/v1/jobs/3f9a2c1d", with: .fixture("GET_v1_jobs_3f9a2c1d.handoff.json"))
        fake.reply("GET", "/v1/jobs/3f9a2c1d/workers", with: .fixture("GET_v1_jobs_3f9a2c1d_workers.handoff.json"))
        fake.reply("GET", "/v1/jobs/ffffffff", with: .fixture("GET_v1_jobs_ffffffff.job_not_found.json", status: 404))
        let store = RelayStore(client: DaemonClient(location: fake.location))
        var presented = 0
        let windows = LinkWindows(store: store, actions: CardActions()) { _ in presented += 1 }

        let link = try #require(URL(string: "relay://job/3f9a2c1d"))
        windows.open(link)
        windows.open(link)
        #expect(windows.windows.keys.sorted() == ["3f9a2c1d"])
        #expect(presented == 2)
        try await until { store.jobsByID["3f9a2c1d"] != nil && store.workersByJob["3f9a2c1d"]?.count == 2 }

        windows.open(try #require(URL(string: "relay://job/3f9a2c1d?switch=codex:personal")))
        windows.open(try #require(URL(string: "relay://switch/codex:personal")))
        #expect(windows.windows.count == 1)

        windows.open(try #require(URL(string: "relay://job/ffffffff")))
        try await until { store.missingJobs["ffffffff"] != nil }
        let model = CardModel.make(store.cardInput(jobID: "ffffffff"), now: Date(), calendar: Sample.calendar, locale: Sample.locale)
        guard case .state(let card) = model else {
            Issue.record("Expected a state card, got \(model)")
            return
        }
        #expect(card.message.plain == "No job with id ffffffff.")
        #expect(windows.windows.count == 2)
        #expect(fake.requests.allSatisfy { $0.method == "GET" })
        #expect(Set(fake.requests.map(\.path)) == ["/v1/jobs/3f9a2c1d", "/v1/jobs/3f9a2c1d/workers", "/v1/jobs/ffffffff"])
        windows.windows.values.forEach { $0.close() }
    }

    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<500 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        Issue.record("Condition not met within 5 seconds")
    }
}
