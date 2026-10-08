import Darwin
import Foundation

/// One connection to a Unix-domain socket, made with the C socket calls so that the peer's user ID
/// can be checked before any byte is written (design.md decision 4). Used by one thread at a time.
public final class UnixSocket {
    private var fd: Int32

    private init(fd: Int32) {
        self.fd = fd
    }

    deinit {
        close()
    }

    /// Connects to `path` and checks with `getpeereid` that the peer runs as `expectedUID`.
    public static func connect(path: String, timeout: Double, expectedUID: uid_t = getuid()) throws -> UnixSocket {
        let pathBytes = Array(path.utf8)
        guard pathBytes.count <= SocketLocation.maxPathBytes else { throw SocketError.pathTooLong(path) }
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SocketError.system(call: "socket", code: errno) }
        let socket = UnixSocket(fd: fd)
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        var one: Int32 = 1
        guard setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            throw SocketError.system(call: "setsockopt", code: errno)
        }
        var limit = timeval(tv_sec: Int(timeout), tv_usec: Int32((timeout - Double(Int(timeout))) * 1_000_000))
        for option in [SO_RCVTIMEO, SO_SNDTIMEO] {
            guard setsockopt(fd, SOL_SOCKET, option, &limit, socklen_t(MemoryLayout<timeval>.size)) == 0 else {
                throw SocketError.system(call: "setsockopt", code: errno)
            }
        }

        var address = sockaddr_un()
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: pathBytes) }
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if result != 0 {
            let code = errno
            switch code {
            case ENOENT, ECONNREFUSED: throw SocketError.notRunning
            case EAGAIN, ETIMEDOUT: throw SocketError.timedOut
            default: throw SocketError.system(call: "connect", code: code)
            }
        }

        var peerUID: uid_t = 0
        var peerGID: gid_t = 0
        guard getpeereid(fd, &peerUID, &peerGID) == 0, peerUID == expectedUID else {
            throw SocketError.peerIsAnotherUser
        }
        return socket
    }

    public func writeAll(_ bytes: [UInt8]) throws {
        var offset = 0
        while offset < bytes.count {
            let written = bytes.withUnsafeBytes { buffer in
                Darwin.write(fd, buffer.baseAddress! + offset, buffer.count - offset)
            }
            if written < 0 {
                let code = errno
                if code == EINTR { continue }
                if code == EAGAIN { throw SocketError.timedOut }
                throw SocketError.system(call: "write", code: code)
            }
            offset += written
        }
    }

    /// Waits at most `seconds` for bytes. Returns `nil` when none arrived in that time and an empty
    /// array when the other side closed the connection.
    public func read(waitingAtMost seconds: Double) throws -> [UInt8]? {
        var request = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        let ready = Darwin.poll(&request, 1, Int32(seconds * 1000))
        if ready < 0 {
            let code = errno
            if code == EINTR { return nil }
            throw SocketError.system(call: "poll", code: code)
        }
        if ready == 0 { return nil }
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
        if count < 0 {
            let code = errno
            if code == EINTR || code == EAGAIN { return nil }
            throw SocketError.system(call: "read", code: code)
        }
        return Array(buffer[0..<count])
    }

    public func close() {
        if fd >= 0 {
            Darwin.close(fd)
            fd = -1
        }
    }
}
