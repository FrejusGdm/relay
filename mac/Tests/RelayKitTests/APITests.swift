import Foundation
@testable import RelayKit
import RelayTestSupport
import Testing

@Suite(.timeLimit(.minutes(1)))
struct APITests {
    @Test func everyFixtureDecodes() throws {
        struct Accounts: Decodable { let accounts: [Account] }
        struct Jobs: Decodable { let jobs: [Job] }
        struct OneJob: Decodable { let job: Job }
        struct Workers: Decodable { let workers: [Worker] }
        struct ErrorBody: Decodable { struct Inner: Decodable { let code: String; let message: String }; let error: Inner }

        let version = try APIDecoder.decode(VersionInfo.self, from: Fixtures.bytes("api/GET_v1_version.json"))
        #expect(version.api == "v1")
        #expect(version.streamEpoch == "9c41d0e2a7b35f18")
        #expect(version.capabilities.contains("jobs.switch"))

        let accounts = try APIDecoder.decode(Accounts.self, from: Fixtures.bytes("api/GET_v1_accounts.json")).accounts
        #expect(accounts.map(\.target) == ["claude:personal", "claude:work", "codex:personal"])
        #expect(accounts.map(\.availability.status) == [.unknown, .rateLimited, .available])
        #expect(accounts[2].usage.first?.usedPercent == 9)

        let jobs = try APIDecoder.decode(Jobs.self, from: Fixtures.bytes("api/GET_v1_jobs.handoff.json")).jobs
        #expect(jobs.first?.currentWorker?.target == "codex:personal")
        #expect(jobs.first?.lastCheckpoint?.kind == .handoff)
        #expect(try APIDecoder.decode(Jobs.self, from: Fixtures.bytes("api/GET_v1_jobs.empty.json")).jobs.isEmpty)
        #expect(try APIDecoder.decode(OneJob.self, from: Fixtures.bytes("api/GET_v1_jobs_3f9a2c1d.handoff.json")).job == jobs.first)

        let workers = try APIDecoder.decode(Workers.self, from: Fixtures.bytes("api/GET_v1_jobs_3f9a2c1d_workers.handoff.json")).workers
        #expect(workers.map(\.id) == ["5d2e8f01", "a17c9e42"])
        #expect(workers[1].endReason == .stoppedBySwitch)
        #expect(workers[1].state == .ended)

        let error = try APIDecoder.decode(ErrorBody.self, from: Fixtures.bytes("api/GET_v1_jobs_ffffffff.job_not_found.json"))
        #expect(error.error.code == "job_not_found")

        _ = try APIDecoder.decode(Job.self, from: Fixtures.bytes("api/events/job.json"))
        _ = try APIDecoder.decode(Worker.self, from: Fixtures.bytes("api/events/worker.json"))
        _ = try APIDecoder.decode(CheckpointChange.self, from: Fixtures.bytes("api/events/checkpoint.json"))
        _ = try APIDecoder.decode(AvailabilityChange.self, from: Fixtures.bytes("api/events/availability.json"))
    }

    @Test func extraFieldIsIgnored() throws {
        var object = try #require(JSONSerialization.jsonObject(with: Data(Fixtures.bytes("api/events/job.json"))) as? [String: Any])
        object["priority"] = 3
        let bytes = Array(try JSONSerialization.data(withJSONObject: object))
        let job = try APIDecoder.decode(Job.self, from: bytes)
        #expect(job == (try APIDecoder.decode(Job.self, from: Fixtures.bytes("api/events/job.json"))))
    }

    @Test func unknownValuesDecodeAsOther() throws {
        let availability = try APIDecoder.decode(
            Availability.self,
            from: Array(#"{"status":"paused","reason":null,"retry_at":null,"measured_at":null,"source":null}"#.utf8)
        )
        #expect(availability.status == .other("paused"))
        let worker = try Fixtures.text("api/events/worker.json")
            .replacingOccurrences(of: #""state": "running""#, with: #""state": "sleeping""#)
            .replacingOccurrences(of: #""mode": "interactive""#, with: #""mode": "remote""#)
        let decoded = try APIDecoder.decode(Worker.self, from: Array(worker.utf8))
        #expect(decoded.state == .other("sleeping"))
        #expect(decoded.mode == .other("remote"))
    }

    @Test func nullFieldsStayNil() throws {
        let accounts = try APIDecoder.decode([String: [Account]].self, from: Fixtures.bytes("api/GET_v1_accounts.json"))
        let unmeasured = try #require(accounts["accounts"]?.first)
        #expect(unmeasured.availability.reason == nil)
        #expect(unmeasured.availability.retryAt == nil)
        #expect(unmeasured.availability.measuredAt == nil)
        #expect(unmeasured.availability.source == nil)
        let worker = try APIDecoder.decode(Worker.self, from: Fixtures.bytes("api/events/worker.json"))
        #expect(worker.endedAt == nil)
        #expect(worker.exitCode == nil)
        #expect(worker.endReason == nil)
        #expect(worker.providerSessionId == nil)
    }

    @Test func datesWithAndWithoutFractionalSeconds() throws {
        struct Stamp: Decodable { let at: Date }
        let fractional = try APIDecoder.decode(Stamp.self, from: Array(#"{"at":"2026-10-07T14:02:11.402Z"}"#.utf8))
        let whole = try APIDecoder.decode(Stamp.self, from: Array(#"{"at":"2026-10-07T14:02:11Z"}"#.utf8))
        #expect(abs(fractional.at.timeIntervalSince(whole.at) - 0.402) < 0.0005)
        #expect(whole.at == Date(timeIntervalSince1970: 1_791_381_731))
        #expect(throws: DecodingError.self) {
            _ = try APIDecoder.decode(Stamp.self, from: Array(#"{"at":"7 October 2026"}"#.utf8))
        }
    }

    @Test func snapshotNumberComesFromTheHeader() async throws {
        let fake = try FakeDaemon()
        defer { fake.stop() }
        let client = DaemonClient(location: fake.location)

        fake.reply("GET", "/v1/jobs", with: .fixture("GET_v1_jobs.handoff.json", streamSeq: 4180))
        #expect(try await client.jobs().streamSeq == 4180)

        fake.reply("GET", "/v1/jobs", with: .fixture("GET_v1_jobs.handoff.json"))
        #expect(try await client.jobs().streamSeq == nil)

        let head = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nRelay-Stream-Seq: 41a\r\nContent-Length: 11\r\n\r\n{\"jobs\":[]}"
        fake.reply("GET", "/v1/jobs", with: .raw(Array(head.utf8)))
        #expect(try await client.jobs().streamSeq == nil)
    }

    @Test func invalidIDsThrowBeforeAnyRequest() async throws {
        let fake = try FakeDaemon()
        defer { fake.stop() }
        let client = DaemonClient(location: fake.location)
        for id in ["3F9A2C1D", "3f9a2c1", "3f9a2c1d0", "../../v1", "3f9a2c1d?x=1", ""] {
            await #expect(throws: ClientError.invalidJobID(id)) { _ = try await client.job(id) }
            await #expect(throws: ClientError.invalidJobID(id)) { _ = try await client.workers(jobID: id) }
        }
        #expect(fake.requests.isEmpty)

        for target in ["codex:personal", "claude:work", "my-agent:team_2", "codex:1"] {
            #expect(RelayID.isTarget(target), "\(target)")
        }
        for target in ["codex personal", "Codex:personal", "codex:", ":personal", "codex:_x", "1codex:a", "codex:a:b", "codex:pers onal"] {
            #expect(!RelayID.isTarget(target), "\(target)")
        }
    }

    @Test func daemonWithoutEventStreamIsIncompatible() async throws {
        let fake = try FakeDaemon()
        defer { fake.stop() }
        let client = DaemonClient(location: fake.location)
        #expect(try await client.checkedVersion().value.pid == 4121)
        fake.setVersion(capabilities: ["accounts", "jobs", "jobs.switch"])
        await #expect(throws: ClientError.incompatibleDaemon) { _ = try await client.checkedVersion() }
        #expect(fake.requests.allSatisfy { $0.path == "/v1/version" })
    }

    @Test func everyRecordedPathIsAllowed() async throws {
        let fake = try FakeDaemon()
        defer { fake.stop() }
        fake.reply("GET", "/v1/accounts", with: .fixture("GET_v1_accounts.json"))
        fake.reply("GET", "/v1/jobs", with: .fixture("GET_v1_jobs.handoff.json"))
        fake.reply("GET", "/v1/jobs/3f9a2c1d", with: .fixture("GET_v1_jobs_3f9a2c1d.handoff.json"))
        fake.reply("GET", "/v1/jobs/3f9a2c1d/workers", with: .fixture("GET_v1_jobs_3f9a2c1d_workers.handoff.json"))
        let feed = EventFeed()
        fake.reply("GET", "/v1/events", with: .feed(feed))
        let client = DaemonClient(location: fake.location)

        _ = try await client.checkedVersion()
        #expect(try await client.accounts().value.count == 3)
        #expect(try await client.jobs().value.first?.id == "3f9a2c1d")
        #expect(try await client.job("3f9a2c1d").value.title == "Build authentication")
        #expect(try await client.workers(jobID: "3f9a2c1d").value.count == 2)
        feed.push("retry: 1000\n\n")
        feed.close()
        for try await _ in client.events(lastEventID: 7) {}

        let allowed = [#"^GET /v1/version$"#, #"^GET /v1/accounts$"#, #"^GET /v1/jobs$"#, #"^GET /v1/jobs/[0-9a-f]{8}$"#,
                       #"^GET /v1/jobs/[0-9a-f]{8}/workers$"#, #"^GET /v1/events$"#, #"^POST /v1/jobs/[0-9a-f]{8}/switch$"#]
        #expect(fake.requests.count == 6)
        for request in fake.requests {
            let line = "\(request.method) \(request.path)"
            #expect(allowed.contains { line.range(of: $0, options: .regularExpression) != nil }, "\(line)")
        }
    }
}
