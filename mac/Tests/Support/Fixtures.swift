import Foundation

/// The JSON files in `Tests/Fixtures/`, read from the source tree (design.md decision 1).
public enum Fixtures {
    public static let directory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("Fixtures")

    public static func bytes(_ name: String) throws -> [UInt8] {
        Array(try Data(contentsOf: directory.appendingPathComponent(name)))
    }

    public static func text(_ name: String) throws -> String {
        String(decoding: try bytes(name), as: UTF8.self)
    }
}

/// A new private folder under `/tmp`, short enough for socket paths.
public func makeTemporaryFolder() throws -> String {
    var template = Array("/tmp/relay-mac-XXXXXX".utf8CString)
    let path = template.withUnsafeMutableBufferPointer { buffer -> String? in
        guard let result = mkdtemp(buffer.baseAddress) else { return nil }
        return String(cString: result)
    }
    guard let path else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    return path
}
