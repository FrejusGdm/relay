import Foundation

/// `relay://job/<id>` links (design.md decision 12). They only open a view of a job; any other
/// link is ignored without a message and without a request.
public enum RelayLink {
    public static func parse(_ url: URL) -> String? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == "relay",
              parts.host == "job",
              parts.user == nil, parts.password == nil, parts.port == nil,
              parts.query == nil, parts.fragment == nil,
              parts.percentEncodedPath.hasPrefix("/")
        else { return nil }
        let id = String(parts.percentEncodedPath.dropFirst())
        return RelayID.isJobID(id) ? id : nil
    }
}
