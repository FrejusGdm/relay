import Foundation
import Observation

/// The "Switch worker…" sheet as a state machine (design.md decision 11). Every message it shows
/// from the daemon is the API's `message`, word for word.
@MainActor
@Observable
public final class SwitchFlow {
    public enum Phase: Equatable, Sendable {
        case choosing
        case sending
        /// The engine asked to confirm the first handoff to a new provider.
        case confirming(message: String)
        /// A question the API cannot answer; the person runs `command` in a terminal.
        case runInTerminal(message: String, command: String)
        case failed(message: String)
        case noAnswer
    }

    public struct Option: Equatable, Sendable, Identifiable {
        public var id: String { target }
        public let target: String
        public let providerName: String
        public let availability: String
        public let isWarning: Bool
    }

    public static let sendingNote =
        "This can take a few minutes while relay saves the work and runs the job's checks. You can close this window; the switch continues."
    public static let noAnswerText =
        "relay did not answer. The switch may still be running; this card updates when relay reports it."

    public let options: [Option]
    public let explanation: String
    public private(set) var phase: Phase = .choosing
    public var selectedTarget: String?
    /// True once the sheet should close: after a `200` or after "Cancel".
    public private(set) var isClosed = false

    private let jobID: String
    private let projectRoot: String
    private let client: DaemonClient
    private let onSwitched: (Worker) -> Void
    private var sentConfirmation = false

    public init(job: Job, accounts: [Account], client: DaemonClient, now: Date, onSwitched: @escaping (Worker) -> Void) {
        jobID = job.id
        projectRoot = job.projectRoot
        self.client = client
        self.onSwitched = onSwitched
        let byTarget = Dictionary(accounts.map { ($0.target, $0) }, uniquingKeysWith: { first, _ in first })
        let words = CardWords(now: now, calendar: .autoupdatingCurrent, locale: .autoupdatingCurrent)
        let current = job.currentWorker.flatMap { worker -> Worker? in
            [WorkerState.running, .starting, .stopped].contains(worker.state) ? worker : nil
        }
        options = accounts
            .filter { $0.configured && $0.target != current?.target }
            .sorted { $0.target < $1.target }
            .map { account in
                let availability = words.availability(account.availability)
                return Option(
                    target: account.target,
                    providerName: CardWords.providerName(target: account.target, accounts: byTarget),
                    availability: availability.word,
                    isWarning: availability.isWarning
                )
            }
        if let current, current.state == .running {
            let name = CardWords.providerName(target: current.target, accounts: byTarget)
            explanation = "relay saves a checkpoint, stops \(name) and starts the next agent with the same repository and plan."
        } else {
            explanation = "relay saves a checkpoint and starts the next agent with the same repository and plan."
        }
    }

    /// "Switch to codex:personal", or "Switching…" while the request runs.
    public var switchLabel: String {
        phase == .sending ? "Switching…" : "Switch to " + (selectedTarget ?? "…")
    }

    /// The first request, with `confirm_new_provider` false.
    public func send() async {
        guard phase == .choosing, let target = selectedTarget else { return }
        await request(target: target, confirm: false)
    }

    /// "Send and switch": the same request with `confirm_new_provider` true.
    public func confirm() async {
        guard case .confirming = phase, let target = selectedTarget else { return }
        await request(target: target, confirm: true)
    }

    public func cancel() {
        isClosed = true
    }

    /// `cd '<project_root>' && relay switch <target>`, with each `'` written as `'\''`.
    public static func command(projectRoot: String, target: String) -> String {
        "cd '" + projectRoot.replacingOccurrences(of: "'", with: #"'\''"#) + "' && relay switch " + target
    }

    private func request(target: String, confirm: Bool) async {
        phase = .sending
        sentConfirmation = sentConfirmation || confirm
        do {
            let response = try await client.switchJob(jobID, target: target, confirmNewProvider: confirm)
            onSwitched(response.worker)
            isClosed = true
        } catch let error as APIError {
            let command = Self.command(projectRoot: projectRoot, target: target)
            switch (error.status, error.code) {
            case (409, "confirmation_required") where !sentConfirmation:
                phase = .confirming(message: error.message)
            case (409, "confirmation_required"), (409, "interactive_start_required"):
                phase = .runInTerminal(message: error.message, command: command)
            default:
                phase = .failed(message: error.message)
            }
        } catch {
            phase = .noAnswer
        }
    }
}
