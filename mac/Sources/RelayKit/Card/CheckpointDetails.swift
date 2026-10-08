import Foundation

/// What the checkpoint sheet shows (design.md decision 10).
public struct CheckpointDetails: Equatable, Sendable {
    /// "Checkpoint 7".
    public let title: String
    /// All 40 characters.
    public let commit: String
    /// The time and the age, for example "14:35 · 1 min ago".
    public let saved: StyledText
    public let kind: String
    /// `nil` when the checkpoint has no message.
    public let message: String?
    public let ref: String

    init(_ checkpoint: Checkpoint, words: CardWords) {
        title = "Checkpoint \(checkpoint.number)"
        commit = checkpoint.commit
        saved = StyledText([.mono(words.time(checkpoint.createdAt)), .plain(" · " + words.age(checkpoint.createdAt))])
        kind = Self.words(checkpoint.kind)
        message = checkpoint.message.flatMap { $0.isEmpty ? nil : $0 }
        ref = checkpoint.ref
    }

    static func words(_ kind: CheckpointKind) -> String {
        switch kind {
        case .baseline: "First checkpoint"
        case .manual: "Saved by you"
        case .preRollback: "Saved before a rollback"
        case .handoff: "Saved at a handoff"
        case .auto: "Saved automatically"
        case .other: "Checkpoint"
        }
    }
}
