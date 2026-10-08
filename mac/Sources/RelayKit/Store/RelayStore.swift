import Foundation
import Observation

/// How the app stands with the daemon (design.md decision 9).
public enum ConnectionState: Equatable, Sendable {
    /// Before the first answer.
    case connecting
    case connected
    /// No folder, no socket, `ECONNREFUSED`, a timeout or a `shutdown` event.
    case notRunning
    /// A folder, socket or peer check failed; the app will not connect.
    case refused(SocketError)
    /// `GET /v1/version` failed or lacks what the app needs.
    case tooOld
}

/// The app's copy of relay's state, kept by following the daemon (design.md decision 7). It holds
/// only what the daemon reported and changes only on the daemon's answers and events; its one
/// timer of its own recomputes `now` once a minute so that the card's times stay correct.
@MainActor
@Observable
public final class RelayStore {
    public private(set) var connection: ConnectionState = .connecting
    public private(set) var capabilities: [String] = []
    public private(set) var accountsByTarget: [String: Account] = [:]
    public private(set) var jobsByID: [String: Job] = [:]
    /// The workers of each loaded job, newest first.
    public private(set) var workersByJob: [String: [Worker]] = [:]
    public private(set) var now: Date
    /// The jobs that `relay://` windows show.
    public private(set) var linkedJobs: Set<String> = []
    /// Why each linked job that is not loaded could not be loaded, for example the API's
    /// `job_not_found` message.
    public private(set) var linkProblems: [String: String] = [:]

    let client: DaemonClient
    let clock: any RelayClock
    /// The sequence number of the data each object came from; a missing entry means unknown.
    @ObservationIgnored private var sequence: [String: Int] = [:]
    /// The last event `id` received, which belongs to the daemon instance `cursorInstance`.
    @ObservationIgnored private(set) var cursor: Int?
    @ObservationIgnored private var cursorInstance: DaemonInstance?
    @ObservationIgnored private var failedCycles = 0
    @ObservationIgnored private var retryDelay = 1.0
    @ObservationIgnored private var openWindows = 0
    @ObservationIgnored private var reconnectWait: Task<Void, Error>?
    @ObservationIgnored private var refreshWait: Task<Void, Error>?
    @ObservationIgnored private var switches: [String: SwitchFlow] = [:]
    /// How many connection cycles have started, for tests.
    @ObservationIgnored private(set) var cycleCount = 0
    /// Whether the current event stream has delivered anything after its head, for tests.
    @ObservationIgnored private(set) var streamIsHealthy = false

    static let reconnectWaits = [2.0, 4.0, 8.0, 16.0, 30.0]
    /// The longest wait a `retry:` line can ask for.
    static let longestRetry = 60.0
    static let refreshWithWindow = 30.0
    static let refreshWithoutWindow = 300.0

    public init(client: DaemonClient, clock: any RelayClock = SystemClock()) {
        self.client = client
        self.clock = clock
        now = clock.now
    }

    public var accounts: [Account] {
        accountsByTarget.values.sorted { $0.target < $1.target }
    }

    public var jobs: [Job] {
        jobsByID.values.sorted { $0.updatedAt > $1.updatedAt }
    }

    /// The job the menu-bar card shows (design.md decision 8).
    public var shownJobID: String? {
        CardModel.selectJob(Array(jobsByID.values))?.id
    }

    /// The data the card is built from: the menu-bar card when `jobID` is `nil`, otherwise the
    /// card of a `relay://` window.
    public func cardInput(jobID: String? = nil, host: AgentHost? = nil) -> CardInput {
        CardInput(
            connection: connection,
            jobs: Array(jobsByID.values),
            workersByJob: workersByJob,
            accounts: Array(accountsByTarget.values),
            capabilities: capabilities,
            host: host,
            jobID: jobID,
            linkProblem: jobID.flatMap { linkProblems[$0] }
        )
    }

    /// The process ID of the agent the card for `jobID` shows, when it is running or starting.
    public func agentPID(jobID: String? = nil) -> Int32? {
        let job = jobID.map { jobsByID[$0] } ?? CardModel.selectJob(Array(jobsByID.values))
        guard let worker = job?.currentWorker, worker.state == .running || worker.state == .starting else { return nil }
        return worker.pid
    }

    /// The switch sheet for the job, which hands the new worker to the store when it succeeds. A
    /// switch that is still open, for example one whose request is running while its sheet is
    /// hidden, is returned again, so its answer is not lost.
    public func switchFlow(jobID: String) -> SwitchFlow? {
        if let open = switches[jobID], !open.isClosed { return open }
        guard let job = jobsByID[jobID] else { return nil }
        let flow = SwitchFlow(job: job, accounts: accounts, client: client, now: clock.now) { [weak self] worker in
            self?.adopt(worker)
        }
        switches[jobID] = flow
        return flow
    }

    /// Opens the view a primary action names. It never sends a request to the daemon.
    public func perform(_ action: PrimaryAction, in workspace: any Workspace) {
        action.perform(in: workspace)
    }

    /// A `relay://` window opened for `jobID`: load the job and follow it while the window is open.
    public func openLink(_ jobID: String) {
        linkedJobs.insert(jobID)
        windowOpened()
        Task { await loadLinkedJob(jobID) }
    }

    public func closeLink(_ jobID: String) {
        linkedJobs.remove(jobID)
        windowClosed()
    }

    /// The worker that a switch answered with becomes the job's current worker.
    func adopt(_ worker: Worker) {
        applyWorker(worker, sequenceNumber: nil, fromSnapshot: false)
        guard var job = jobsByID[worker.jobId], job.currentWorker?.id != worker.id else { return }
        job.currentWorker = worker
        jobsByID[worker.jobId] = job
    }

    private func loadLinkedJob(_ jobID: String) async {
        do {
            let job = try await client.job(jobID)
            linkProblems.removeValue(forKey: jobID)
            applyJob(job.value, sequenceNumber: job.streamSeq, fromSnapshot: true)
            let workers = try await client.workers(jobID: jobID)
            for worker in workers.value {
                applyWorker(worker, sequenceNumber: workers.streamSeq, fromSnapshot: true)
            }
        } catch {
            let notFound = (error as? APIError)?.code == "job_not_found"
            if notFound {
                jobsByID.removeValue(forKey: jobID)
            }
            if jobsByID[jobID] == nil {
                linkProblems[jobID] = Self.linkProblem(error)
            }
        }
    }

    /// What a `relay://` window shows when its job could not be loaded.
    static func linkProblem(_ error: Error) -> String {
        switch error {
        case let apiError as APIError:
            return apiError.message
        case let socketError as SocketError:
            switch socketError {
            case .notRunning, .timedOut, .system: return "relay is not running. " + socketError.message
            default: return socketError.message
            }
        default:
            return "relay did not answer."
        }
    }

    /// Follows the daemon until the task is cancelled.
    public func run() async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.tickEveryMinute() }
            group.addTask { await self.connectLoop() }
            await group.waitForAll()
        }
    }

    /// Ends the wait before the next connection attempt when the app is not connected.
    public func connectNow() {
        if connection != .connected { reconnectWait?.cancel() }
    }

    /// A window of the app opened: refresh at once, then every 30 seconds while one is open.
    public func windowOpened() {
        openWindows += 1
        refreshWait?.cancel()
        connectNow()
    }

    public func windowClosed() {
        openWindows = max(0, openWindows - 1)
    }

    // MARK: The connection cycle

    private func tickEveryMinute() async {
        while !Task.isCancelled {
            do {
                try await clock.sleep(for: 60)
            } catch {
                return
            }
            now = clock.now
        }
    }

    private func connectLoop() async {
        while !Task.isCancelled {
            let healthy = await cycle()
            if Task.isCancelled { return }
            failedCycles = healthy ? 0 : failedCycles + 1
            let delay = failedCycles <= 1 ? retryDelay : Self.reconnectWaits[min(failedCycles - 2, Self.reconnectWaits.count - 1)]
            reconnectWait = Task { [clock] in try await clock.sleep(for: delay) }
            await waitFor(reconnectWait)
        }
    }

    /// One connection: version, event stream, snapshots, then events until the stream ends.
    /// Returns whether the cycle was healthy (design.md decision 7, step 4).
    private func cycle() async -> Bool {
        cycleCount += 1
        streamIsHealthy = false
        let version: VersionInfo
        do {
            version = try await client.checkedVersion().value
        } catch {
            connection = Self.state(after: error, duringVersion: true)
            return false
        }
        capabilities = version.capabilities
        let instance = DaemonInstance(version)
        if cursorInstance != instance {
            cursor = nil
            sequence = [:]
            cursorInstance = instance
        }

        let events = client.events(lastEventID: cursor)
        do {
            try await loadSnapshots()
        } catch {
            connection = Self.state(after: error, duringVersion: false)
            return false
        }
        connection = .connected

        let refresher = Task { await self.refreshLoop() }
        defer { refresher.cancel() }
        do {
            for try await event in events {
                if !streamIsHealthy {
                    streamIsHealthy = true
                    failedCycles = 0
                }
                await apply(event)
            }
        } catch {}
        return streamIsHealthy
    }

    private func refreshLoop() async {
        while !Task.isCancelled {
            let interval = openWindows > 0 ? Self.refreshWithWindow : Self.refreshWithoutWindow
            refreshWait = Task { [clock] in try await clock.sleep(for: interval) }
            await waitFor(refreshWait)
            if Task.isCancelled { return }
            try? await loadSnapshots()
        }
    }

    /// Waits for `task`, and cancels it when the waiting task is cancelled.
    private func waitFor(_ task: Task<Void, Error>?) async {
        guard let task else { return }
        await withTaskCancellationHandler {
            _ = try? await task.value
        } onCancel: {
            task.cancel()
        }
    }

    private func loadSnapshots() async throws {
        let accounts = try await client.accounts()
        let jobs = try await client.jobs()
        applyAccounts(accounts)
        applyJobs(jobs)
        if let jobID = shownJobID {
            let workers = try await client.workers(jobID: jobID)
            for worker in workers.value {
                applyWorker(worker, sequenceNumber: workers.streamSeq, fromSnapshot: true)
            }
        }
        for jobID in linkedJobs.sorted() where jobID != shownJobID {
            await loadLinkedJob(jobID)
        }
    }

    private static func state(after error: Error, duringVersion: Bool) -> ConnectionState {
        switch error {
        case let socketError as SocketError:
            switch socketError {
            case .notRunning, .timedOut, .system: return .notRunning
            default: return .refused(socketError)
            }
        case let httpError as HTTPError where httpError == .timedOut || httpError == .closedEarly:
            return .notRunning
        default:
            return duringVersion ? .tooOld : .notRunning
        }
    }

    // MARK: Ordering snapshots and events

    private func apply(_ event: ServerEvent) async {
        if let id = event.id { cursor = id }
        switch event.payload {
        case .job(let job):
            applyJob(job, sequenceNumber: event.id, fromSnapshot: false)
        case .worker(let worker):
            applyWorker(worker, sequenceNumber: event.id, fromSnapshot: false)
        case .checkpoint(let change):
            applyCheckpoint(change, sequenceNumber: event.id)
        case .availability(let change):
            applyAvailability(change, sequenceNumber: event.id)
        case .reset:
            cursor = nil
            sequence = [:]
            try? await loadSnapshots()
        case .shutdown:
            connection = .notRunning
        case .retry(let milliseconds):
            retryDelay = min(Double(milliseconds) / 1000, Self.longestRetry)
        case .keepAlive, .ignored:
            break
        }
    }

    /// Whether data numbered `incoming` replaces data numbered by `key`: by sequence numbers when
    /// both are known (a snapshot also on a tie), and by `fallback` otherwise.
    private func accepts(_ key: String, _ incoming: Int?, fromSnapshot: Bool, fallback: () -> Bool) -> Bool {
        if let incoming, let stored = sequence[key] {
            return fromSnapshot ? incoming >= stored : incoming > stored
        }
        return fallback()
    }

    private func record(_ key: String, _ number: Int?) {
        sequence[key] = number
    }

    private func applyAccounts(_ snapshot: Snapshot<[Account]>) {
        for account in snapshot.value {
            let key = "availability:" + account.target
            guard let old = accountsByTarget[account.target] else {
                accountsByTarget[account.target] = account
                record(key, snapshot.streamSeq)
                continue
            }
            if accepts(key, snapshot.streamSeq, fromSnapshot: true, fallback: {
                Self.isNewer(account.availability.measuredAt, than: old.availability.measuredAt)
            }) {
                accountsByTarget[account.target] = account
                record(key, snapshot.streamSeq)
            } else {
                var merged = account
                merged.availability = old.availability
                merged.usage = old.usage
                accountsByTarget[account.target] = merged
            }
        }
    }

    private func applyAvailability(_ change: AvailabilityChange, sequenceNumber: Int?) {
        let key = "availability:" + change.target
        guard var account = accountsByTarget[change.target] else { return }
        guard accepts(key, sequenceNumber, fromSnapshot: false, fallback: {
            Self.isNewer(change.availability.measuredAt, than: account.availability.measuredAt)
        }) else { return }
        account.availability = change.availability
        if let usage = change.usage { account.usage = usage }
        accountsByTarget[change.target] = account
        record(key, sequenceNumber)
    }

    private func applyJobs(_ snapshot: Snapshot<[Job]>) {
        let listed = Set(snapshot.value.map(\.id))
        for id in jobsByID.keys where !listed.contains(id) {
            if let number = snapshot.streamSeq, let stored = sequence["job:" + id], stored > number { continue }
            jobsByID.removeValue(forKey: id)
            workersByJob.removeValue(forKey: id)
        }
        for job in snapshot.value {
            applyJob(job, sequenceNumber: snapshot.streamSeq, fromSnapshot: true)
        }
    }

    private func applyJob(_ job: Job, sequenceNumber: Int?, fromSnapshot: Bool) {
        let key = "job:" + job.id
        guard let old = jobsByID[job.id] else {
            jobsByID[job.id] = job
            record(key, sequenceNumber)
            return
        }
        let accepted = accepts(key, sequenceNumber, fromSnapshot: fromSnapshot, fallback: { job.updatedAt > old.updatedAt })
        var merged = accepted ? job : old
        if accepted { record(key, sequenceNumber) }
        merged.currentWorker = Self.forward(old.currentWorker, job.currentWorker, accepted: accepted)
        merged.lastCheckpoint = Self.later(old.lastCheckpoint, job.lastCheckpoint)
        jobsByID[job.id] = merged
    }

    private func applyWorker(_ worker: Worker, sequenceNumber: Int?, fromSnapshot: Bool) {
        let key = "worker:" + worker.id
        guard var job = jobsByID[worker.jobId] else { return }
        var list = workersByJob[worker.jobId] ?? []
        let accepted = accepts(key, sequenceNumber, fromSnapshot: fromSnapshot, fallback: { true })
        if let index = list.firstIndex(where: { $0.id == worker.id }) {
            list[index] = Self.forward(list[index], worker, accepted: accepted) ?? worker
        } else {
            list.append(worker)
        }
        if accepted { record(key, sequenceNumber) }
        workersByJob[worker.jobId] = list.sorted { ($0.startedAt ?? .distantPast) > ($1.startedAt ?? .distantPast) }
        if let current = job.currentWorker, current.id == worker.id {
            job.currentWorker = Self.forward(current, worker, accepted: accepted)
            jobsByID[worker.jobId] = job
        }
    }

    private func applyCheckpoint(_ change: CheckpointChange, sequenceNumber: Int?) {
        let key = "checkpoint:" + change.jobId
        guard var job = jobsByID[change.jobId] else { return }
        guard accepts(key, sequenceNumber, fromSnapshot: false, fallback: {
            change.checkpoint.number > (job.lastCheckpoint?.number ?? Int.min)
        }) else { return }
        job.lastCheckpoint = change.checkpoint
        jobsByID[change.jobId] = job
        record(key, sequenceNumber)
    }

    /// A worker's state only moves forward, and a worker with `ended_at` keeps it (design.md
    /// decision 7). On a tie the accepted data wins.
    nonisolated static func forward(_ old: Worker?, _ new: Worker?, accepted: Bool) -> Worker? {
        guard let old, let new, old.id == new.id else { return accepted ? new : old }
        if let oldRank = rank(old.state), let newRank = rank(new.state), oldRank != newRank {
            return newRank > oldRank ? new : old
        }
        let chosen = accepted ? new : old
        if chosen.endedAt == nil, old.endedAt != nil { return old }
        return chosen
    }

    nonisolated static func rank(_ state: WorkerState) -> Int? {
        switch state {
        case .starting: 0
        case .running: 1
        case .stopped: 2
        case .ended: 3
        case .other: nil
        }
    }

    private static func later(_ first: Checkpoint?, _ second: Checkpoint?) -> Checkpoint? {
        guard let first, let second else { return first ?? second }
        return second.number > first.number ? second : first
    }

    /// `null` is the oldest time.
    private static func isNewer(_ candidate: Date?, than stored: Date?) -> Bool {
        guard let candidate else { return false }
        guard let stored else { return true }
        return candidate > stored
    }
}

/// What the event cursor belongs to (design.md decision 7): the index's `stream_epoch` when the
/// daemon sends it, so the cursor survives a restart that kept the index; otherwise the daemon's
/// process ID and start time.
enum DaemonInstance: Equatable {
    case epoch(String)
    case process(pid: Int32, startedAt: Date)

    init(_ version: VersionInfo) {
        if let epoch = version.streamEpoch {
            self = .epoch(epoch)
        } else {
            self = .process(pid: version.pid, startedAt: version.startedAt)
        }
    }
}
