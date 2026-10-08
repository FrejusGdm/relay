import Darwin

/// Reads a process's parent, so tests can give a fake process tree (design.md decision 10).
public protocol ProcessTable: Sendable {
    func parent(of pid: Int32) -> Int32?
}

/// The real process table, read with `proc_pidinfo` and `PROC_PIDTBSDINFO`.
public struct SystemProcessTable: ProcessTable {
    public init() {}

    public func parent(of pid: Int32) -> Int32? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return Int32(bitPattern: info.pbi_ppid)
    }
}
