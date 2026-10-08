import Darwin
import Foundation

/// Where relay's socket is, and the checks made before every connection (design.md decision 4).
public struct SocketLocation: Equatable, Sendable {
    /// `sun_path` holds 104 bytes on macOS, including the final zero byte.
    public static let maxPathBytes = 103

    public let home: String

    public init(home: String) {
        self.home = home
    }

    public var directory: String { home + "/run" }
    public var socketPath: String { directory + "/relay.sock" }

    /// `RELAY_HOME` from the app's environment when it is set and absolute, else `~/.relay`.
    public static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: String = NSHomeDirectory()
    ) -> SocketLocation {
        if var value = environment["RELAY_HOME"], value.hasPrefix("/") {
            while value.count > 1 && value.hasSuffix("/") { value.removeLast() }
            return SocketLocation(home: value)
        }
        return SocketLocation(home: home + "/.relay")
    }

    /// Checks, without following symbolic links, that the folder is private and owned by the
    /// current user and that `relay.sock` is a socket owned by that user.
    public func check(uid: uid_t = getuid()) throws {
        guard socketPath.utf8.count <= Self.maxPathBytes else {
            throw SocketError.pathTooLong(socketPath)
        }
        var info = stat()
        if lstat(directory, &info) != 0 {
            let code = errno
            if code == ENOENT || code == ENOTDIR { throw SocketError.notRunning }
            throw SocketError.system(call: "lstat", code: code)
        }
        let folderType = info.st_mode & 0o170000
        if folderType == 0o120000 { throw SocketError.folderIsSymbolicLink(directory) }
        if folderType != 0o040000 || info.st_uid != uid || info.st_mode & 0o077 != 0 {
            throw SocketError.folderNotPrivate(directory)
        }
        if lstat(socketPath, &info) != 0 {
            let code = errno
            if code == ENOENT { throw SocketError.notRunning }
            throw SocketError.system(call: "lstat", code: code)
        }
        if info.st_mode & 0o170000 != 0o140000 { throw SocketError.notASocket(socketPath) }
        if info.st_uid != uid { throw SocketError.socketOwnedByAnotherUser(socketPath) }
    }
}
