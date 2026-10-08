import Foundation

/// `relay://job/<id>` links (design.md decision 12). They only open a view of a job; any other
/// link is ignored without a message and without a request.
public enum RelayLink {
    public static func parse(_ url: URL) -> String? {
        // Compared as text: `URLComponents` reads "relay://job:/…" as having no port and
        // "relay://@job/…" as having no user, and both must be ignored.
        let text = url.absoluteString
        let prefix = "relay://job/"
        guard text.count == prefix.count + 8, text.lowercased().hasPrefix("relay:"),
              text.dropFirst(6).hasPrefix("//job/")
        else { return nil }
        let id = String(text.suffix(8))
        return RelayID.isJobID(id) ? id : nil
    }
}
