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
        /// A question the API cannot answer; the person runs `command` in a terminal. `command` is
        /// `nil` when the project path cannot be quoted safely for every shell.
        case runInTerminal(message: String, command: String?)
        case failed(message: String)
        /// The connection closed or the 15 minutes passed: the switch may still be running.
        case noAnswer
        /// The person pressed "Cancel"; nothing more is sent.
        case cancelled
    }

    /// A button of the sheet. The views draw exactly these, in this order.
    public struct Button: Equatable, Sendable {
        public enum Role: Equatable, Sendable {
            case send, sendConfirmed, cancel, close
            case copyCommand(String)
        }

        public enum Key: Equatable, Sendable {
            /// The Return key (the default button).
            case returnKey
            /// The Escape key.
            case escapeKey
        }

        public let title: String
        public let role: Role
        public let isPrimary: Bool
        public let isEnabled: Bool
        public let key: Key?
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

    /// The sheet's buttons in the current phase. "Send and switch" has no key, so a second press of
    /// Return cannot answer the provider question before the person has read it.
    public var buttons: [Button] {
        let target = selectedTarget ?? "…"
        switch phase {
        case .choosing:
            return [
                Button(title: "Cancel", role: .cancel, isPrimary: false, isEnabled: true, key: .escapeKey),
                Button(title: "Switch to " + target, role: .send, isPrimary: true, isEnabled: selectedTarget != nil, key: .returnKey),
            ]
        case .sending:
            return [
                Button(title: "Close", role: .close, isPrimary: false, isEnabled: true, key: .escapeKey),
                Button(title: "Switching…", role: .send, isPrimary: true, isEnabled: false, key: nil),
            ]
        case .confirming:
            return [
                Button(title: "Cancel", role: .cancel, isPrimary: false, isEnabled: true, key: .escapeKey),
                Button(title: "Send and switch", role: .sendConfirmed, isPrimary: true, isEnabled: true, key: nil),
            ]
        case .runInTerminal(_, let command):
            let copy = command.map { [Button(title: "Copy command", role: .copyCommand($0), isPrimary: false, isEnabled: true, key: nil)] }
            return (copy ?? []) + [Button(title: "Close", role: .close, isPrimary: false, isEnabled: true, key: .escapeKey)]
        case .failed, .noAnswer:
            return [Button(title: "Close", role: .close, isPrimary: false, isEnabled: true, key: .escapeKey)]
        case .cancelled:
            return []
        }
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

    /// "Cancel": ends the flow; nothing more is ever sent.
    public func cancel() {
        guard phase != .sending else { return }
        phase = .cancelled
        isClosed = true
    }

    /// "Close", or the window going away. While the request runs the flow stays open, so a later
    /// question from the daemon is shown when the person opens "Switch worker…" again.
    public func dismiss() {
        if phase != .sending { isClosed = true }
    }

    /// `cd '<project_root>' && relay switch <target>`, with each `'` written as `'\''`. That quoting
    /// is right for sh, bash and zsh; fish also treats a backslash inside single quotes, so a path
    /// with a backslash or a control character gets no command (design.md decision 11).
    public static func command(projectRoot: String, target: String) -> String? {
        let unsafe = projectRoot.unicodeScalars.contains { $0 == "\\" || $0.value < 0x20 || $0.value == 0x7F }
        guard !unsafe else { return nil }
        return "cd '" + projectRoot.replacingOccurrences(of: "'", with: #"'\''"#) + "' && relay switch " + target
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
        } catch let error as HTTPError where error == .timedOut || error == .closedEarly {
            phase = .noAnswer
        } catch let error as SocketError {
            switch error {
            case .notRunning, .timedOut, .system:
                phase = .failed(message: "The switch was not sent, because relay is not running. " + error.message)
            default:
                phase = .failed(message: "The switch was not sent. " + error.message)
            }
        } catch ClientError.invalidTarget(let target) {
            phase = .failed(message: "The switch was not sent, because \(target) is not an account name.")
        } catch {
            phase = .failed(message: "relay sent an answer this app cannot read. The switch may have run; this card updates when relay reports it.")
        }
    }
}
