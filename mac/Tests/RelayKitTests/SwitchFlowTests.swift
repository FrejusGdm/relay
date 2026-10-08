import Foundation
@testable import RelayKit
import RelayTestSupport
import Testing

@MainActor
@Suite(.timeLimit(.minutes(1)))
struct SwitchFlowTests {
    static let path = "/v1/jobs/3f9a2c1d/switch"
    static let question = "This sends the repository and the job notes to OpenAI through the account codex:personal. Continue?"

    let fake: FakeDaemon

    init() throws {
        fake = try FakeDaemon()
    }

    func flow(projectRoot: String = "/Users/dev/projects/auth", onSwitched: @escaping (Worker) -> Void = { _ in }) throws -> SwitchFlow {
        var job = Sample.jobJSON(current: Sample.workerJSON(id: "a17c9e42", target: "claude:work", fromHandoff: false))
        job["project_root"] = projectRoot
        var unconfigured = Sample.accountJSON(target: "claude:old")
        unconfigured["configured"] = false
        let accounts = try [
            Sample.accountJSON(target: "codex:personal"),
            Sample.accountJSON(target: "claude:work", status: "rate_limited"),
            Sample.accountJSON(target: "claude:home"),
            unconfigured,
        ].map { try Sample.decode(Account.self, $0) }
        let flow = SwitchFlow(
            job: try Sample.decode(Job.self, job),
            accounts: accounts,
            client: DaemonClient(location: fake.location),
            now: FixedClock().now,
            onSwitched: onSwitched
        )
        flow.selectedTarget = "codex:personal"
        return flow
    }

    func error(_ code: String, _ message: String, status: Int = 409) -> FakeDaemon.Reply {
        .json(Sample.text(["error": ["code": code, "message": message]]), status: status)
    }

    var posts: [FakeDaemon.Request] { fake.requests("POST", Self.path) }

    @Test func listsConfiguredAccountsExceptTheCurrentOne() throws {
        defer { fake.stop() }
        let flow = try flow()
        #expect(flow.options.map(\.target) == ["claude:home", "codex:personal"])
        #expect(flow.options.map(\.providerName) == ["Claude Code", "Codex"])
        #expect(flow.explanation == "relay saves a checkpoint, stops Claude Code and starts the next agent with the same repository and plan.")
        flow.selectedTarget = nil
        #expect(flow.switchLabel == "Switch to …")
        flow.selectedTarget = "codex:personal"
        #expect(flow.switchLabel == "Switch to codex:personal")
    }

    @Test func oneRequestAndASuccessCloses() async throws {
        defer { fake.stop() }
        var received: [Worker] = []
        fake.reply("POST", Self.path, with: .json(Sample.text(["handoff": ["checkpoint": 8], "worker": Sample.workerJSON()])))
        let flow = try flow { received.append($0) }
        await flow.send()
        #expect(flow.isClosed)
        #expect(received.map(\.target) == ["codex:personal"])
        #expect(posts.count == 1)
        #expect(String(decoding: posts[0].body, as: UTF8.self) == #"{"target":"codex:personal","confirm_new_provider":false}"#)
        #expect(posts[0].headers["content-type"] == "application/json")
    }

    @Test func confirmationSendsTheRequestAgainWithConfirm() async throws {
        defer { fake.stop() }
        fake.reply("POST", Self.path, with: error("confirmation_required", Self.question))
        let flow = try flow()
        await flow.send()
        #expect(flow.phase == .confirming(message: Self.question))
        fake.reply("POST", Self.path, with: .json(Sample.text(["worker": Sample.workerJSON()])))
        await flow.confirm()
        #expect(flow.isClosed)
        #expect(posts.map { String(decoding: $0.body, as: UTF8.self) } == [
            #"{"target":"codex:personal","confirm_new_provider":false}"#,
            #"{"target":"codex:personal","confirm_new_provider":true}"#,
        ])
    }

    @Test func cancelSendsNothing() async throws {
        defer { fake.stop() }
        fake.reply("POST", Self.path, with: error("confirmation_required", Self.question))
        let flow = try flow()
        await flow.send()
        flow.cancel()
        #expect(flow.isClosed)
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(posts.count == 1)
    }

    @Test func secondConfirmationEndsWithTheTerminalCommand() async throws {
        defer { fake.stop() }
        fake.reply("POST", Self.path, with: error("confirmation_required", Self.question))
        let flow = try flow()
        await flow.send()
        let other = "AGENTS.md changed since the last handoff. Continue?"
        fake.reply("POST", Self.path, with: error("confirmation_required", other))
        await flow.confirm()
        #expect(flow.phase == .runInTerminal(message: other, command: "cd '/Users/dev/projects/auth' && relay switch codex:personal"))
        #expect(posts.count == 2)
    }

    @Test func interactiveStartShowsTheCommandWithTheQuoteRule() async throws {
        defer { fake.stop() }
        let message = "This switch needs a terminal. Run relay switch codex:personal in the project."
        fake.reply("POST", Self.path, with: error("interactive_start_required", message))
        let flow = try flow(projectRoot: "/Users/dev/it's here")
        await flow.send()
        #expect(flow.phase == .runInTerminal(message: message, command: #"cd '/Users/dev/it'\''s here' && relay switch codex:personal"#))
        #expect(posts.count == 1)
    }

    @Test func otherErrorsShowTheirMessage() async throws {
        defer { fake.stop() }
        fake.reply("POST", Self.path, with: error("operation_in_progress", "Job 3f9a2c1d is already being checkpointed."))
        let flow = try flow()
        await flow.send()
        #expect(flow.phase == .failed(message: "Job 3f9a2c1d is already being checkpointed."))
    }

    @Test func closedConnectionIsNotRetried() async throws {
        defer { fake.stop() }
        fake.reply("POST", Self.path, with: .raw([]))
        let flow = try flow()
        await flow.send()
        #expect(flow.phase == .noAnswer)
        #expect(SwitchFlow.noAnswerText == "relay did not answer. The switch may still be running; this card updates when relay reports it.")
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(posts.count == 1)
    }

    @Test func successfulSwitchShowsCodexOnTheCard() async throws {
        let running = Sample.workerJSON(id: "a17c9e42", target: "claude:work", fromHandoff: false, startedAt: "2026-10-07T12:10:40.000Z")
        let harness = try StoreHarness { fake in
            fake.reply("GET", "/v1/jobs", with: .json(Sample.text(["jobs": [Sample.jobJSON(current: running)]])))
            fake.reply("GET", "/v1/jobs/3f9a2c1d/workers", with: .json(Sample.text(["workers": [running]])))
            fake.reply("POST", Self.path, with: .json(Sample.text(["worker": Sample.workerJSON()])))
        }
        defer {
            harness.finish(posts: 1)
            fake.stop()
        }
        _ = try await harness.connect()
        let flow = try #require(harness.store.switchFlow(jobID: "3f9a2c1d"))
        #expect(flow.options.map(\.target) == ["claude:personal", "codex:personal"])
        flow.selectedTarget = "codex:personal"
        await flow.send()
        #expect(flow.isClosed)
        guard case .job(let card) = harness.card() else {
            Issue.record("Expected a job card")
            return
        }
        #expect(card.rows.last?.providerName == "Codex")
        #expect(card.rows.last?.isCurrent == true)
        #expect(harness.fake.requests("POST", Self.path).count == 1)
    }
}

struct RelayLinkTests {
    @Test(arguments: ["relay://job/3f9a2c1d", "RELAY://job/3f9a2c1d", "Relay://job/0123abcd"])
    func accepted(link: String) throws {
        let url = try #require(URL(string: link))
        #expect(RelayLink.parse(url) == String(link.suffix(8)))
    }

    @Test(arguments: [
        "relay://job/3F9A2C1D",
        "relay://job/3f9a2c1",
        "relay://job/3f9a2c1d0",
        "relay://job/3f9a2c1d?switch=codex:personal",
        "relay://job/3f9a2c1d?",
        "relay://job/3f9a2c1d#top",
        "relay://job:8080/3f9a2c1d",
        "relay://user@job/3f9a2c1d",
        "relay://user:secret@job/3f9a2c1d",
        "relay://job/3f9a2c1d/",
        "relay://job/%33f9a2c1d",
        "relay://switch/codex:personal",
        "relay://checkpoint/3f9a2c1d",
        "https://job/3f9a2c1d",
        "relay:job/3f9a2c1d",
    ])
    func ignored(link: String) throws {
        let url = try #require(URL(string: link))
        #expect(RelayLink.parse(url) == nil)
    }
}
