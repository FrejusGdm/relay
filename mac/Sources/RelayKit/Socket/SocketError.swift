import Foundation

/// Why the app cannot use relay's socket. The messages are those of design.md decision 9.
public enum SocketError: Error, Equatable, Sendable {
    /// No folder, no socket, `ENOENT` or `ECONNREFUSED` on connect.
    case notRunning
    case pathTooLong(String)
    case folderNotPrivate(String)
    case folderIsSymbolicLink(String)
    case notASocket(String)
    case socketOwnedByAnotherUser(String)
    case peerIsAnotherUser
    case timedOut
    /// A system call failed with this `errno`.
    case system(call: String, code: Int32)

    public var message: String {
        switch self {
        case .notRunning, .timedOut, .system:
            "Start it in a terminal: relay daemon start"
        case .pathTooLong(let path):
            "The socket path \(path) is too long. Set RELAY_HOME to a shorter path."
        case .folderNotPrivate(let directory):
            "\(directory) must be private (mode 0700, owned by you). Fix it with: chmod 700 \(directory)"
        case .folderIsSymbolicLink(let directory):
            "\(directory) is a symbolic link. relay only uses a real folder."
        case .notASocket(let path):
            "\(path) exists and is not a socket."
        case .socketOwnedByAnotherUser, .peerIsAnotherUser:
            "The relay socket belongs to another user."
        }
    }
}
