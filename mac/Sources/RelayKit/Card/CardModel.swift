import Foundation

/// Everything the card is built from.
public struct CardInput: Sendable {
    public var connection: ConnectionState
    public var jobs: [Job]
    /// The workers of each job, newest first.
    public var workersByJob: [String: [Worker]]
    public var accounts: [Account]
    public var capabilities: [String]
    /// The app that runs the current agent, for example Terminal, when the app found one.
    public var host: AgentHost?
    /// The job a `relay://` window shows; `nil` for the menu-bar card, which chooses its job.
    public var jobID: String?
    /// Why the job `jobID` could not be loaded, for example the API's `job_not_found` message.
    public var linkProblem: String?

    public init(
        connection: ConnectionState,
        jobs: [Job],
        workersByJob: [String: [Worker]],
        accounts: [Account],
        capabilities: [String],
        host: AgentHost? = nil,
        jobID: String? = nil,
        linkProblem: String? = nil
    ) {
        self.connection = connection
        self.jobs = jobs
        self.workersByJob = workersByJob
        self.accounts = accounts
        self.capabilities = capabilities
        self.host = host
        self.jobID = jobID
        self.linkProblem = linkProblem
    }
}

public struct UsageLine: Equatable, Sendable {
    /// The used share of the window, from 0 to 1.
    public let fraction: Double
    public let text: StyledText
}

public struct WorkerRow: Equatable, Sendable {
    public let providerName: String
    /// "Previous worker", "Current worker" or "Last worker".
    public let role: String
    public let account: String
    public let state: StyledText
    public let stateTone: Tone
    public let isCurrent: Bool
    public let usage: UsageLine?
}

/// The caption between the previous and the current worker.
public struct Connector: Equatable, Sendable {
    public let title: StyledText
    public let detail: String?
}

public struct Fact: Equatable, Sendable {
    public let label: String
    public let value: StyledText
}

/// The primary action opens a view and never sends a request (design.md decision 10).
public enum PrimaryAction: Equatable, Sendable {
    case openHost(provider: String, app: String, pid: Int32)
    case showInFinder(path: String)

    public var label: String {
        switch self {
        case .openHost(let provider, let app, _): "Open \(provider) in \(app)"
        case .showInFinder: "Show project in Finder"
        }
    }

    /// The shorter label of the tiny card, as in `docs/design/preview.html`.
    public var tinyLabel: String {
        switch self {
        case .openHost(let provider, _, _): "Open \(provider) ↗"
        case .showInFinder: "Show in Finder ↗"
        }
    }
}

public struct JobCard: Equatable, Sendable {
    public let jobID: String
    public let title: String
    /// "auth · 3f9a2c1d", or "Project folder not found" when `projectMissing`.
    public let repository: StyledText
    public let projectMissing: Bool
    public let status: StyledText
    public let rows: [WorkerRow]
    public let connector: Connector?
    public let facts: [Fact]
    public let tinyNote: String
    /// What the checkpoint sheet shows, when the job has a checkpoint.
    public let checkpoint: CheckpointDetails?
    public let primaryAction: PrimaryAction?
    public let showsViewCheckpoint: Bool
    public let showsSwitchWorker: Bool
}

/// A card without a job to show (design.md decision 9).
public struct StateCard: Equatable, Sendable {
    public let title: String
    public let message: StyledText
    /// The command that "Copy command" puts on the clipboard.
    public let command: String?
}

/// Every string and flag the card views need, made by one pure function (design.md decision 8).
public enum CardModel: Equatable, Sendable {
    case job(JobCard)
    case state(StateCard)

    /// The menu-bar icon's accessibility label.
    public var accessibilityLabel: String {
        switch self {
        case .job(let card): "relay: " + card.status.plain
        case .state(let card): "relay: " + card.title
        }
    }

    /// Among jobs whose current worker is running or starting, the newest; otherwise the newest.
    public static func selectJob(_ jobs: [Job]) -> Job? {
        let active = jobs.filter { $0.currentWorker?.state == .running || $0.currentWorker?.state == .starting }
        return (active.isEmpty ? jobs : active).max { $0.updatedAt < $1.updatedAt }
    }

    public static func make(_ input: CardInput, now: Date, calendar: Calendar, locale: Locale) -> CardModel {
        if let message = input.linkProblem {
            return .state(StateCard(title: "relay", message: .text(message), command: nil))
        }
        switch input.connection {
        case .connecting:
            return .state(StateCard(title: "relay", message: .text("Connecting to relay…"), command: nil))
        case .notRunning:
            return commandState("relay is not running", "Start it in a terminal: ", "relay daemon start")
        case .tooOld:
            return commandState("This relay is too old for this app", "Update relay, then run: ", "relay daemon restart")
        case .refused(let error):
            return refusedState(error)
        case .connected:
            break
        }
        if let jobID = input.jobID {
            guard let job = input.jobs.first(where: { $0.id == jobID }) else {
                return .state(StateCard(title: "relay", message: .text("Connecting to relay…"), command: nil))
            }
            return .job(card(job, input: input, now: now, calendar: calendar, locale: locale))
        }
        guard let job = selectJob(input.jobs) else {
            return .state(StateCard(
                title: "No jobs yet",
                message: StyledText([run("Run "), run("relay init", .mono), run(" in a project to start one.")]),
                command: nil
            ))
        }
        return .job(card(job, input: input, now: now, calendar: calendar, locale: locale))
    }

    private static func card(_ job: Job, input: CardInput, now: Date, calendar: Calendar, locale: Locale) -> JobCard {
        let accounts = Dictionary(input.accounts.map { ($0.target, $0) }, uniquingKeysWith: { first, _ in first })
        let words = CardWords(now: now, calendar: calendar, locale: locale)
        return jobCard(job, workers: input.workersByJob[job.id] ?? [], accounts: accounts, input: input, words: words)
    }

    private static func jobCard(_ job: Job, workers: [Worker], accounts: [String: Account], input: CardInput, words: CardWords) -> JobCard {
        let name = { (worker: Worker) in CardWords.providerName(target: worker.target, accounts: accounts) }
        let availability = { (worker: Worker) in accounts[worker.target].map { words.availability($0.availability) } }

        var current = job.currentWorker
        if let worker = current, let listed = workers.first(where: { $0.id == worker.id }) {
            current = RelayStore.forward(worker, listed, accepted: false)
        }
        if let worker = current, worker.state != .running, worker.state != .starting, worker.state != .stopped {
            current = nil
        }
        let previous = current.flatMap { current in
            workers.first { $0.endedAt != nil && $0.target != current.target && $0.id != current.id }
        }
        let last = current == nil ? (workers.first ?? job.currentWorker) : nil

        func row(_ worker: Worker, role: String, isCurrent: Bool) -> WorkerRow {
            var state = StyledText.text(CardWords.workerWords(worker))
            var tone: Tone = worker.state == .running ? .accent : .plain
            if !isCurrent, let account = availability(worker), account.isWarning || account.isStale {
                state = account.detail
                tone = account.isWarning ? .warning : .plain
            }
            return WorkerRow(
                providerName: name(worker),
                role: role,
                account: CardWords.accountLine(target: worker.target),
                state: state,
                stateTone: isCurrent ? tone : (tone == .accent ? .plain : tone),
                isCurrent: isCurrent,
                usage: accounts[worker.target].flatMap { words.usage($0.usage) }
            )
        }

        var rows: [WorkerRow] = []
        var connector: Connector?
        if let current {
            if let previous {
                rows.append(row(previous, role: "Previous worker", isCurrent: false))
                let lead = current.fromHandoff ? "Handed off" : "Started"
                let title = current.startedAt.map { StyledText([.plain(lead + " · "), .mono(words.time($0))]) } ?? .text(lead)
                connector = Connector(title: title, detail: current.fromHandoff ? "Same repository & plan" : nil)
            }
            rows.append(row(current, role: "Current worker", isCurrent: true))
        } else if let last {
            rows.append(row(last, role: "Last worker", isCurrent: false))
        }

        let status: StyledText
        if let current {
            let currentName = name(current)
            switch current.state {
            case .running where current.fromHandoff:
                if let previous, let account = availability(previous), account.isWarning, !account.isStale,
                   accounts[previous.target]?.availability.status != .unavailable {
                    status = .strong("Moved to \(currentName)", [.plain("\(name(previous)) reached its limit")])
                } else if let previous {
                    status = .strong("Moved to \(currentName)", [.plain("from \(name(previous))")])
                } else {
                    status = .strong("Moved to \(currentName)")
                }
            case .running:
                status = .strong("\(currentName) is working")
            case .starting:
                status = .strong("Starting \(currentName)")
            default:
                status = .strong("\(currentName) stopped", [.plain("relay did not record why")])
            }
        } else if let last, let account = accounts[last.target],
                  account.availability.status == .rateLimited || account.availability.status == .quotaExhausted,
                  !words.availability(account.availability).isStale {
            let reset: [StyledText.Run] = account.availability.retryAt.map { date -> [StyledText.Run] in [.plain("\(name(last)) resets "), .mono(words.time(date))] }
                ?? [.plain("\(name(last)) reset unknown")]
            status = .strong("Limit reached", reset)
        } else {
            status = .strong("No agent is working on this job")
        }

        let checkpoint = job.lastCheckpoint
        let shortCommit = checkpoint.map { String($0.commit.prefix(6)) }
        var facts = [Fact(
            label: "Checkpoint",
            value: checkpoint.map {
                StyledText([run(String($0.commit.prefix(6)), .mono), run(" · saved ", .muted), run(words.time($0.createdAt), .mutedMono)])
            }
                ?? .text("None yet")
        )]
        let handedOff = current?.fromHandoff == true
        if handedOff {
            facts.append(Fact(label: "Carried over", value: .text("Repository, checkpoint & plan")))
        }

        let primary: PrimaryAction?
        if job.projectMissing {
            primary = nil
        } else if let current, current.state == .running || current.state == .starting, let pid = current.pid,
                  let host = input.host, host.agentPID == pid {
            primary = .openHost(provider: name(current), app: host.name, pid: host.pid)
        } else {
            primary = .showInFinder(path: job.projectRoot)
        }

        let folder = URL(fileURLWithPath: job.projectRoot).lastPathComponent
        return JobCard(
            jobID: job.id,
            title: job.title.flatMap { $0.isEmpty ? nil : $0 } ?? "Job \(job.id)",
            repository: job.projectMissing
                ? .text("Project folder not found")
                : StyledText([run(folder + " · "), run(job.id, .mono)]),
            projectMissing: job.projectMissing,
            status: status,
            rows: rows,
            connector: connector,
            facts: facts,
            tinyNote: handedOff ? "Same checkpoint & plan" : shortCommit.map { "Checkpoint " + $0 } ?? "No checkpoint yet",
            checkpoint: checkpoint.map { CheckpointDetails($0, words: words) },
            primaryAction: primary,
            showsViewCheckpoint: checkpoint != nil,
            showsSwitchWorker: input.capabilities.contains("jobs.switch") && !job.projectMissing
        )
    }

    private static func commandState(_ title: String, _ lead: String, _ command: String) -> CardModel {
        .state(StateCard(title: title, message: StyledText([run(lead), run(command, .mono)]), command: command))
    }

    private static func refusedState(_ error: SocketError) -> CardModel {
        let title = "relay will not connect"
        let message: StyledText
        var command: String?
        switch error {
        case .folderNotPrivate(let directory):
            command = "chmod 700 \(directory)"
            message = StyledText([run(directory, .mono), run(" must be private (mode 0700, owned by you). Fix it with: "), run(command ?? "", .mono)])
        case .folderIsSymbolicLink(let directory):
            message = StyledText([run(directory, .mono), run(" is a symbolic link. relay only uses a real folder.")])
        case .notASocket(let path):
            message = StyledText([run(path, .mono), run(" exists and is not a socket.")])
        case .pathTooLong(let path):
            message = StyledText([run("The socket path "), run(path, .mono), run(" is too long. Set RELAY_HOME to a shorter path.")])
        case .peerIsAnotherUser, .socketOwnedByAnotherUser:
            message = .text("The relay socket belongs to another user.")
        case .notRunning, .timedOut, .system:
            return commandState("relay is not running", "Start it in a terminal: ", "relay daemon start")
        }
        return .state(StateCard(title: title, message: message, command: command))
    }

    private static func run(_ text: String, _ style: StyledText.Style = .plain) -> StyledText.Run {
        StyledText.Run(text: text, style: style)
    }
}
