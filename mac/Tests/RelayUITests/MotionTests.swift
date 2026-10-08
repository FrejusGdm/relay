import RelayKit
import RelayTestSupport
import RelayUI
import SwiftUI
import Testing

struct MotionTests {
    @Test func reduceMotionMeansNoAnimation() {
        #expect(CardMotion.expand(reduceMotion: true) == nil)
        #expect(CardMotion.expand(reduceMotion: false) != nil)
    }

    @Test func accessibilityLabelOfTheHandoffFixture() throws {
        let input = try Sample.fixtureHandoff()
        #expect(Sample.card(input).accessibilityLabel == "relay: Moved to Codex · Claude Code reached its limit")
    }

    @MainActor
    @Test func menuBarGlyphIsATemplate() {
        #expect(RelayGlyph.menuBarImage().isTemplate)
    }
}
