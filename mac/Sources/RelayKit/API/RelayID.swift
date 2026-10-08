/// The checks on job IDs and targets made before any request is built (phase 5 decision 14), so no
/// other text reaches a request line.
public enum RelayID {
    /// `^[0-9a-f]{8}$`
    public static func isJobID(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        return bytes.count == 8 && bytes.allSatisfy { isDigit($0) || ($0 >= 97 && $0 <= 102) }
    }

    /// `^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9_-]*$`
    public static func isTarget(_ text: String) -> Bool {
        let parts = text.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return false }
        let provider = Array(parts[0].utf8)
        let account = Array(parts[1].utf8)
        guard let first = provider.first, isLower(first),
              provider.allSatisfy({ isLower($0) || isDigit($0) || $0 == 45 }),
              let accountFirst = account.first, isLower(accountFirst) || isDigit(accountFirst),
              account.allSatisfy({ isLower($0) || isDigit($0) || $0 == 45 || $0 == 95 })
        else { return false }
        return true
    }

    private static func isDigit(_ byte: UInt8) -> Bool { byte >= 48 && byte <= 57 }
    private static func isLower(_ byte: UInt8) -> Bool { byte >= 97 && byte <= 122 }
}
