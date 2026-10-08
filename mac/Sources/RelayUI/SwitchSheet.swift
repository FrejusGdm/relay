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
        SheetFrame(title: "Switch worker") {
            switch flow.phase {
            case .choosing, .sending, .cancelled:
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
            case .confirming(let message), .failed(let message):
                paragraph(message, palette(.ink))
            case .runInTerminal(let message, let command):
                paragraph(message, palette(.ink))
                if let command {
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
                }
            case .noAnswer:
                paragraph(SwitchFlow.noAnswerText, palette(.ink))
            }
        } buttons: {
            ForEach(Array(flow.buttons.enumerated()), id: \.offset) { _, button in
                if button.isPrimary {
                    PrimaryButton(label: button.title, isEnabled: button.isEnabled, isDefault: button.key == .returnKey) {
                        press(button.role)
                    }
                    .fixedSize()
                } else {
                    SecondaryButton(title: button.title, isCancel: button.key == .escapeKey) {
                        press(button.role)
                    }
                }
            }
        }
        .onChange(of: flow.isClosed) { _, isClosed in
            if isClosed { close() }
        }
    }

    private func press(_ role: SwitchFlow.Button.Role) {
        switch role {
        case .send: Task { await flow.send() }
        case .sendConfirmed: Task { await flow.confirm() }
        case .cancel: flow.cancel()
        case .close:
            flow.dismiss()
            close()
        case .copyCommand(let command): copy(command)
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
