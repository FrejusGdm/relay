import Darwin
import Foundation
import RelayKit
import RelayTestSupport
import Testing

@Suite(.timeLimit(.minutes(1)))
struct SocketTests {
    @Test func defaultPathIsInTheHomeFolder() {
        let location = SocketLocation.resolve(environment: [:])
        #expect(location.socketPath == NSHomeDirectory() + "/.relay/run/relay.sock")
        #expect(SocketLocation.resolve(environment: [:], home: "/Users/dev").socketPath == "/Users/dev/.relay/run/relay.sock")
        #expect(SocketLocation.resolve(environment: ["RELAY_HOME": "/srv/relay/"]).socketPath == "/srv/relay/run/relay.sock")
        #expect(SocketLocation.resolve(environment: ["RELAY_HOME": "relative"], home: "/Users/dev").socketPath == "/Users/dev/.relay/run/relay.sock")
    }

    @Test func socketPathOf104BytesIsRefused() throws {
        let suffix = "/run/relay.sock"
        let home = "/tmp/" + String(repeating: "h", count: 104 - 5 - suffix.utf8.count)
        let location = SocketLocation(home: home)
        #expect(location.socketPath.utf8.count == 104)
        #expect(throws: SocketError.pathTooLong(location.socketPath)) { try location.check() }
        #expect(throws: SocketError.pathTooLong(location.socketPath)) {
            try UnixSocket.connect(path: location.socketPath, timeout: 2)
        }
        #expect(SocketError.pathTooLong(location.socketPath).message
            == "The socket path \(location.socketPath) is too long. Set RELAY_HOME to a shorter path.")

        let shorter = SocketLocation(home: String(home.dropLast()))
        #expect(shorter.socketPath.utf8.count == 103)
        #expect(throws: SocketError.notRunning) { try shorter.check() }
    }

    @Test func folderOpenToOthersIsRefused() throws {
        let home = try makeTemporaryFolder()
        defer { try? FileManager.default.removeItem(atPath: home) }
        let location = SocketLocation(home: home)
        #expect(mkdir(location.directory, 0o700) == 0)
        #expect(chmod(location.directory, 0o755) == 0)
        #expect(throws: SocketError.folderNotPrivate(location.directory)) { try location.check() }
        #expect(SocketError.folderNotPrivate(location.directory).message
            == "\(location.directory) must be private (mode 0700, owned by you). Fix it with: chmod 700 \(location.directory)")
    }

    @Test func folderThatIsASymbolicLinkIsRefused() throws {
        let home = try makeTemporaryFolder()
        defer { try? FileManager.default.removeItem(atPath: home) }
        let location = SocketLocation(home: home)
        #expect(mkdir(home + "/real", 0o700) == 0)
        #expect(symlink(home + "/real", location.directory) == 0)
        #expect(throws: SocketError.folderIsSymbolicLink(location.directory)) { try location.check() }
        #expect(SocketError.folderIsSymbolicLink(location.directory).message
            == "\(location.directory) is a symbolic link. relay only uses a real folder.")
    }

    @Test func missingFolderMeansNotRunning() throws {
        let home = try makeTemporaryFolder()
        defer { try? FileManager.default.removeItem(atPath: home) }
        #expect(throws: SocketError.notRunning) { try SocketLocation(home: home).check() }
        #expect(throws: SocketError.notRunning) { try SocketLocation(home: home + "/missing").check() }
    }

    @Test func regularFileInPlaceOfTheSocketIsRefused() throws {
        let home = try makeTemporaryFolder()
        defer { try? FileManager.default.removeItem(atPath: home) }
        let location = SocketLocation(home: home)
        #expect(mkdir(location.directory, 0o700) == 0)
        #expect(FileManager.default.createFile(atPath: location.socketPath, contents: Data("x".utf8)))
        #expect(throws: SocketError.notASocket(location.socketPath)) { try location.check() }
        #expect(SocketError.notASocket(location.socketPath).message == "\(location.socketPath) exists and is not a socket.")
    }

    @Test func connectsToTheFakeDaemon() throws {
        let fake = try FakeDaemon()
        defer { fake.stop() }
        try fake.location.check()
        let socket = try UnixSocket.connect(path: fake.location.socketPath, timeout: 2)
        socket.close()
        #expect(fake.wait { fake.receivedByteCounts.count == 1 })
    }

    @Test func peerRunningAsAnotherUserGetsNoBytes() throws {
        let fake = try FakeDaemon()
        defer { fake.stop() }
        #expect(throws: SocketError.peerIsAnotherUser) {
            try UnixSocket.connect(path: fake.location.socketPath, timeout: 2, expectedUID: getuid() + 1)
        }
        #expect(fake.wait { fake.receivedByteCounts.count == 1 })
        #expect(fake.receivedByteCounts == [0])
        #expect(fake.requests.isEmpty)
        #expect(SocketError.peerIsAnotherUser.message == "The relay socket belongs to another user.")
    }
}
