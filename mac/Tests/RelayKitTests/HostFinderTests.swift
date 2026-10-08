import Foundation
@testable import RelayKit
import RelayTestSupport
import Testing

/// A process tree given by the test, which counts its lookups.
final class FakeProcessTable: ProcessTable, @unchecked Sendable {
    private let lock = NSLock()
    private let parents: [Int32: Int32]
    private var count = 0

    init(_ parents: [Int32: Int32]) {
        self.parents = parents
    }

    var lookups: Int { lock.withLock { count } }

    func parent(of pid: Int32) -> Int32? {
        lock.withLock {
            count += 1
            return parents[pid]
        }
    }
}

/// Records what the app asked of macOS.
@MainActor
final class FakeWorkspace: Workspace {
    var apps: [Int32: String] = [:]
    var activated: [Int32] = []
    var shown: [String] = []
    var copied: [String] = []

    func regularAppName(pid: Int32) -> String? { apps[pid] }
    func activate(pid: Int32) { activated.append(pid) }
    func showInFinder(path: String) { shown.append(path) }
    func copy(_ text: String) { copied.append(text) }
}

@MainActor
struct HostFinderTests {
    @Test func agentInATerminalOpensTheTerminal() throws {
        let workspace = FakeWorkspace()
        workspace.apps = [400: "Terminal"]
        let table = FakeProcessTable([5120: 5000, 5000: 4990, 4990: 400, 400: 1])
        let host = HostFinder(table: table, workspace: workspace).host(of: 5120)
        #expect(host == AgentHost(pid: 400, name: "Terminal"))

        var input = try Sample.handoff(host: nil)
        input.host = host
        guard case .job(let card) = Sample.card(input) else {
            Issue.record("Expected a job card")
            return
        }
        #expect(card.primaryAction?.label == "Open Codex in Terminal")
    }

    @Test func chainThatReachesProcessOneShowsTheProject() throws {
        let workspace = FakeWorkspace()
        let host = HostFinder(table: FakeProcessTable([5120: 5000, 5000: 1]), workspace: workspace).host(of: 5120)
        #expect(host == nil)
        var input = try Sample.handoff(host: nil)
        input.host = host
        guard case .job(let card) = Sample.card(input) else {
            Issue.record("Expected a job card")
            return
        }
        #expect(card.primaryAction?.label == "Show project in Finder")
    }

    @Test func loopInTheTreeStopsAfter32Steps() {
        let table = FakeProcessTable([5120: 5000, 5000: 5120])
        #expect(HostFinder(table: table, workspace: FakeWorkspace()).host(of: 5120) == nil)
        #expect(table.lookups <= HostFinder.maxSteps)
    }

    @Test func actionsSendNoRequest() throws {
        let fake = try FakeDaemon()
        defer { fake.stop() }
        let workspace = FakeWorkspace()
        PrimaryAction.openHost(provider: "Codex", app: "Terminal", pid: 400).perform(in: workspace)
        PrimaryAction.showInFinder(path: "/Users/dev/projects/auth").perform(in: workspace)
        #expect(workspace.activated == [400])
        #expect(workspace.shown == ["/Users/dev/projects/auth"])
        #expect(fake.requests.isEmpty)
    }
}

struct CheckpointSheetTests {
    @Test(arguments: [
        ("baseline", "First checkpoint"),
        ("manual", "Saved by you"),
        ("pre_rollback", "Saved before a rollback"),
        ("handoff", "Saved at a handoff"),
        ("auto", "Saved automatically"),
        ("archived", "Checkpoint"),
    ])
    func kindWords(kind: String, words: String) {
        #expect(CheckpointDetails.words(CheckpointKind(rawString: kind)) == words)
    }

    @Test func detailsOfTheHandoffCheckpoint() throws {
        var json = Sample.checkpointJSON()
        let now = FixedClock().now.addingTimeInterval(3 * 60)
        let words = CardWords(now: now, calendar: Sample.calendar, locale: Sample.locale)
        let details = CheckpointDetails(try Sample.decode(Checkpoint.self, json), words: words)
        #expect(details.title == "Checkpoint 7")
        #expect(details.commit == Sample.commit)
        #expect(details.saved.plain == "14:35 · 3 min ago")
        #expect(details.kind == "Saved at a handoff")
        #expect(details.message == "Handoff from claude:work to codex:personal")
        #expect(details.ref == "refs/relay/jobs/3f9a2c1d/checkpoints/7")

        json["message"] = ""
        #expect(CheckpointDetails(try Sample.decode(Checkpoint.self, json), words: words).message == nil)
    }

    @Test func ages() {
        let now = FixedClock().now
        let words = CardWords(now: now, calendar: Sample.calendar, locale: Sample.locale)
        #expect(words.age(now.addingTimeInterval(-20)) == "just now")
        #expect(words.age(now.addingTimeInterval(-4 * 60)) == "4 min ago")
        #expect(words.age(now.addingTimeInterval(-3 * 3600)) == "3 h ago")
        #expect(words.age(now.addingTimeInterval(-2 * 86400)) == "Mon 14:36")
    }
}
