import AppKit
import SwiftUI

/// The relay glyph: a line that steps down from one track to the next (`docs/design/preview.html`,
/// symbol `g`, 16 by 12).
public struct RelayGlyph: Shape {
    public init() {}

    public func path(in rect: CGRect) -> Path {
        let x = rect.width / 16
        let y = rect.height / 12
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY + 3.2 * y))
        path.addLine(to: CGPoint(x: rect.minX + 8.2 * x, y: rect.minY + 3.2 * y))
        path.addLine(to: CGPoint(x: rect.minX + 8.2 * x, y: rect.minY + 8.8 * y))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + 8.8 * y))
        return path
    }

    /// The menu-bar icon: the glyph as a template image, so macOS colors it for the menu bar.
    @MainActor
    public static func menuBarImage() -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 14), flipped: true) { _ in
            let path = NSBezierPath()
            path.move(to: NSPoint(x: 1, y: 1 + 3.2))
            path.line(to: NSPoint(x: 1 + 8.2, y: 1 + 3.2))
            path.line(to: NSPoint(x: 1 + 8.2, y: 1 + 8.8))
            path.line(to: NSPoint(x: 17, y: 1 + 8.8))
            path.lineWidth = 1.6
            path.lineJoinStyle = .miter
            NSColor.black.setStroke()
            path.stroke()
            return true
        }
        image.isTemplate = true
        return image
    }
}

/// The arrow of the preview's symbol `rc-right` (20 by 20).
struct RightArrow: Shape {
    func path(in rect: CGRect) -> Path {
        let unit = rect.width / 20
        let point = { (x: CGFloat, y: CGFloat) in CGPoint(x: rect.minX + x * unit, y: rect.minY + y * unit) }
        var path = Path()
        path.move(to: point(3, 10))
        path.addLine(to: point(16, 10))
        path.move(to: point(11, 5))
        path.addLine(to: point(16, 10))
        path.addLine(to: point(11, 15))
        return path
    }
}

/// The connector arrow between two workers (14 by 65).
struct DownArrow: Shape {
    func path(in rect: CGRect) -> Path {
        let point = { (x: CGFloat, y: CGFloat) in CGPoint(x: rect.minX + x * rect.width / 14, y: rect.minY + y * rect.height / 65) }
        var path = Path()
        path.move(to: point(7, 1))
        path.addLine(to: point(7, 60))
        path.move(to: point(2, 55))
        path.addLine(to: point(7, 61))
        path.addLine(to: point(12, 55))
        return path
    }
}

/// The folder in front of the repository line (16 by 16).
struct FolderIcon: Shape {
    func path(in rect: CGRect) -> Path {
        let unit = rect.width / 16
        let point = { (x: CGFloat, y: CGFloat) in CGPoint(x: rect.minX + x * unit, y: rect.minY + y * unit) }
        var path = Path()
        path.move(to: point(2, 3))
        path.addLine(to: point(7, 3))
        path.addLine(to: point(9, 5))
        path.addLine(to: point(14, 5))
        path.addLine(to: point(14, 13))
        path.addLine(to: point(2, 13))
        path.closeSubpath()
        return path
    }
}

extension Shape {
    func line(_ color: Color, width: CGFloat) -> some View {
        stroke(color, style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
    }
}
