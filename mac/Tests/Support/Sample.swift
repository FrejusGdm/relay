import Foundation
import RelayKit

/// Builds API objects in the phase 5 shapes for tests, as JSON objects and as decoded models.
public enum Sample {
    public static let jobID = "3f9a2c1d"
    public static let commit = "912ec1a4b0d3e5f60718293a4b5c6d7e8f901234"

    public static func workerJSON(
        id: String = "5d2e8f01",
        target: String = "codex:personal",
        state: String = "running",
        pid: Int? = 5120,
        fromHandoff: Bool = true,
        startedAt: String = "2026-10-07T14:36:12.000Z",
        endedAt: String? = nil,
        endReason: String? = nil,
        exitCode: Int? = nil
    ) -> [String: Any] {
        [
            "id": id, "job_id": jobID, "target": target, "mode": "interactive", "state": state,
            "pid": pid as Any? ?? NSNull(), "provider_session_id": NSNull(), "from_handoff": fromHandoff,
            "started_at": startedAt, "ended_at": endedAt as Any? ?? NSNull(),
            "exit_code": exitCode as Any? ?? NSNull(), "end_reason": endReason as Any? ?? NSNull(),
        ]
    }

    /// The Claude Code worker that handed the job to Codex at 14:36.
    public static func previousWorkerJSON(target: String = "claude:work") -> [String: Any] {
        workerJSON(
            id: "a17c9e42", target: target, state: "ended", pid: 4890, fromHandoff: false,
            startedAt: "2026-10-07T12:10:40.000Z", endedAt: "2026-10-07T14:35:58.000Z",
            endReason: "stopped_by_switch", exitCode: 143
        )
    }

    public static func checkpointJSON(number: Int = 7, createdAt: String = "2026-10-07T14:35:51.000Z") -> [String: Any] {
        [
            "number": number, "commit": commit, "ref": "refs/relay/jobs/\(jobID)/checkpoints/\(number)",
            "kind": "handoff", "created_at": createdAt, "message": "Handoff from claude:work to codex:personal",
        ]
    }

    public static func jobJSON(
        id: String = jobID,
        title: String = "Build authentication",
        projectMissing: Bool = false,
        current: [String: Any]? = workerJSON(),
        checkpoint: [String: Any]? = checkpointJSON(),
        updatedAt: String = "2026-10-07T14:36:12.000Z"
    ) -> [String: Any] {
        [
            "id": id, "title": title, "state": "running", "project_root": "/Users/dev/projects/auth",
            "project_missing": projectMissing, "current_worker": current as Any? ?? NSNull(),
            "last_checkpoint": checkpoint as Any? ?? NSNull(), "updated_at": updatedAt,
        ]
    }

    public static func usageJSON(percent: Double, minutes: Int = 300, window: String = "five_hour") -> [String: Any] {
        [
            "window": window, "window_minutes": minutes, "used_percent": percent,
            "resets_at": "2026-10-07T19:00:00.000Z", "measured_at": "2026-10-07T14:30:02.000Z",
        ]
    }

    public static func accountJSON(
        target: String,
        status: String = "available",
        retryAt: String? = nil,
        measuredAt: String? = "2026-10-07T14:02:11.402Z",
        usage: [[String: Any]] = []
    ) -> [String: Any] {
        let parts = target.split(separator: ":").map(String.init)
        let names = ["claude": "Claude Code", "codex": "Codex"]
        return [
            "target": target, "provider": parts[0], "provider_name": names[parts[0]] ?? parts[0], "account": parts[1],
            "configured": true,
            "availability": [
                "status": status, "reason": NSNull(), "retry_at": retryAt as Any? ?? NSNull(),
                "measured_at": measuredAt as Any? ?? NSNull(), "source": "hook",
            ] as [String: Any],
            "usage": usage,
        ]
    }

    /// The JSON text of `object`.
    public static func text(_ object: Any) -> String {
        String(decoding: (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data(), as: UTF8.self)
    }

    /// Decodes `object` the way the app decodes the API.
    public static func decode<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: text) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            guard let date = formatter.date(from: text) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: text))
            }
            return date
        }
        return try decoder.decode(T.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// The card input after a handoff from `claude:work` (limit until 19:00) to `codex:personal`,
    /// which reports 9% of its 5-hour window used.
    public static func handoff(host: String? = "Terminal") throws -> CardInput {
        try input(
            jobs: [jobJSON()],
            workers: [workerJSON(), previousWorkerJSON()],
            accounts: [
                accountJSON(target: "claude:work", status: "rate_limited", retryAt: "2026-10-07T19:00:00.000Z"),
                accountJSON(target: "codex:personal", measuredAt: "2026-10-07T14:30:02.000Z", usage: [usageJSON(percent: 9)]),
            ],
            host: host
        )
    }

    public static func input(
        connection: ConnectionState = .connected,
        jobs: [[String: Any]],
        workers: [[String: Any]] = [],
        accounts: [[String: Any]] = [],
        capabilities: [String] = ["accounts", "jobs", "events.sse", "jobs.checkpoint", "jobs.switch", "hooks"],
        host: String? = nil
    ) throws -> CardInput {
        let decodedWorkers = try workers.map { try decode(Worker.self, $0) }
        return CardInput(
            connection: connection,
            jobs: try jobs.map { try decode(Job.self, $0) },
            workersByJob: Dictionary(grouping: decodedWorkers, by: \.jobId),
            accounts: try accounts.map { try decode(Account.self, $0) },
            capabilities: capabilities,
            host: host.map { Host(pid: hostPID, name: $0) }
        )
    }

    /// The process ID of the app that `input(host:)` names.
    public static let hostPID: Int32 = 400

    /// en_GB, UTC, as every test uses (design.md decision 14).
    public static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        calendar.locale = locale
        return calendar
    }

    public static let locale = Locale(identifier: "en_GB")

    public static func card(_ input: CardInput, now: Date = FixedClock().now) -> CardModel {
        CardModel.make(input, now: now, calendar: calendar, locale: locale)
    }
}

extension Sample {
    /// The card input of the files in `Tests/Fixtures/api/` after the handoff.
    public static func fixtureHandoff(host: String? = "Terminal") throws -> CardInput {
        let json = { (name: String) in try JSONSerialization.jsonObject(with: Data(Fixtures.bytes("api/" + name))) as? [String: Any] ?? [:] }
        return try input(
            jobs: json("GET_v1_jobs.handoff.json")["jobs"] as? [[String: Any]] ?? [],
            workers: json("GET_v1_jobs_3f9a2c1d_workers.handoff.json")["workers"] as? [[String: Any]] ?? [],
            accounts: json("GET_v1_accounts.json")["accounts"] as? [[String: Any]] ?? [],
            host: host
        )
    }
}
