import RelayKit
import SwiftUI

/// "Switch worker…" (design.md decision 11): choose an account, then send one switch request.
/// The daemon's questions appear in its own words.
public struct SwitchSheet: View {
    let flow: SwitchFlow
    let copy: @MainActor (String) -> Void
    let close: @MainActor () -> Void
    @Environment(\.colorScheme) private var scheme

    public init(flow: SwitchFlow, copy: @escaping @MainActor (String) -> Void, close: @escaping @MainActor () -> Void) {
        self.flow = flow
        self.copy = copy
        self.close = close
    }

    public var body: some View {
        let palette = Palette(scheme: scheme)
        Group {
            switch flow.phase {
            case .choosing, .sending:
                choosing(palette)
            case .confirming(let message):
                SheetFrame(title: "Switch worker") {
                    paragraph(message, palette(.ink))
                } buttons: {
                    SecondaryButton(title: "Cancel") { flow.cancel() }
                    PrimaryButton(label: "Send and switch") { Task { await flow.confirm() } }
                        .fixedSize()
                }
            case .runInTerminal(let message, let command):
                SheetFrame(title: "Switch worker") {
                    paragraph(message, palette(.ink))
                    paragraph("Run this in a terminal:", palette(.muted)).padding(.top, 12)
                    Text(command)
                        .font(RelayFont.mono(12))
                        .foregroundStyle(palette(.ink))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .background(RoundedRectangle(cornerRadius: 6).fill(palette(.raised)))
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(palette(.rule), lineWidth: 1))
                        .padding(.top, 8)
                } buttons: {
                    SecondaryButton(title: "Copy command") { copy(command) }
                    SecondaryButton(title: "Close", action: close)
                }
            case .failed(let message):
                SheetFrame(title: "Switch worker") {
                    paragraph(message, palette(.ink))
                } buttons: {
                    SecondaryButton(title: "Close", action: close)
                }
            case .noAnswer:
                SheetFrame(title: "Switch worker") {
                    paragraph(SwitchFlow.noAnswerText, palette(.ink))
                } buttons: {
                    SecondaryButton(title: "Close", action: close)
                }
            }
        }
        .onChange(of: flow.isClosed) { _, isClosed in
            if isClosed { close() }
        }
    }

    private func choosing(_ palette: Palette) -> some View {
        SheetFrame(title: "Switch worker") {
            paragraph(flow.explanation, palette(.muted))
            VStack(spacing: 8) {
                ForEach(flow.options) { option in
                    optionRow(option, palette)
                }
            }
            .padding(.top, 14)
            if flow.phase == .sending {
                paragraph(SwitchFlow.sendingNote, palette(.muted)).padding(.top, 12)
            }
        } buttons: {
            SecondaryButton(title: "Cancel") { flow.cancel() }
            PrimaryButton(label: flow.switchLabel, isEnabled: flow.selectedTarget != nil && flow.phase == .choosing) {
                Task { await flow.send() }
            }
            .fixedSize()
        }
    }

    private func optionRow(_ option: SwitchFlow.Option, _ palette: Palette) -> some View {
        let selected = flow.selectedTarget == option.target
        return Button {
            if flow.phase == .choosing { flow.selectedTarget = option.target }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(option.providerName)
                        .font(RelayFont.text(13, .semibold))
                        .foregroundStyle(palette(.ink))
                    Text(option.target)
                        .font(RelayFont.mono(12))
                        .foregroundStyle(palette(.muted))
                }
                Spacer(minLength: 0)
                Text(option.availability)
                    .font(RelayFont.text(11, .medium))
                    .foregroundStyle(palette(option.isWarning ? .warning : .ink))
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 9).fill(palette(selected ? .accentSoft : .surface)))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(palette(selected ? .accent : .rule), lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func paragraph(_ text: String, _ color: Color) -> some View {
        Text(text)
            .font(RelayFont.text(13))
            .foregroundStyle(color)
            .lineSpacing(4)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
