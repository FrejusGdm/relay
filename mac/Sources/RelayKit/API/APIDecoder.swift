import Foundation

/// Decodes the API's JSON: snake-case keys, and ISO 8601 dates with or without fractional seconds
/// (design.md decision 6). Unknown fields are ignored.
enum APIDecoder {
    static func decode<T: Decodable>(_ type: T.Type, from bytes: [UInt8]) throws -> T {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: text) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            if let date = formatter.date(from: text) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not an ISO 8601 date: \(text)")
        }
        return try decoder.decode(T.self, from: Data(bytes))
    }
}
