import RelayKit
import SwiftUI

/// One worker in the expanded card (`.rc-worker`). The current worker has the accent border and
/// the accent-soft background.
struct WorkerRowView: View {
    let row: WorkerRow
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let palette = Palette(scheme: scheme)
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(row.providerName)
                    .font(RelayFont.text(14, .semibold))
                    .foregroundStyle(palette(.ink))
                Spacer(minLength: 0)
                Text(row.role)
                    .font(RelayFont.text(11))
                    .foregroundStyle(palette(.muted))
            }
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(row.account)
                    .font(RelayFont.text(11))
                    .foregroundStyle(palette(.muted))
                Spacer(minLength: 0)
                Text(row.state)
                    .font(RelayFont.text(11, .medium))
                    .foregroundStyle(stateColor(palette))
            }
            .padding(.top, 7)
            if let usage = row.usage {
                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Capsule().fill(palette(.rule))
                        Capsule().fill(palette(.accent))
                            .frame(width: max(3, proxy.size.width * usage.fraction))
                    }
                }
                .frame(height: 3)
                .padding(.top, 10)
                Text(usage.text)
                    .font(RelayFont.text(11))
                    .foregroundStyle(palette(.muted))
                    .padding(.top, 6)
            }
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, minHeight: 78, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 9).fill(palette(row.isCurrent ? .accentSoft : .surface)))
        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(palette(row.isCurrent ? .accent : .rule), lineWidth: 1))
        .accessibilityElement(children: .combine)
    }

    private func stateColor(_ palette: Palette) -> Color {
        switch row.stateTone {
        case .accent: palette(.accent)
        case .warning: palette(.warning)
        case .plain: palette(.ink)
        }
    }
}

/// The arrow and caption between two workers (`.rc-conn`).
struct ConnectorView: View {
    let connector: Connector
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let palette = Palette(scheme: scheme)
        HStack(spacing: 12) {
            DownArrow().line(palette(.accent), width: 1.5)
                .frame(width: 14, height: 65)
            VStack(alignment: .leading, spacing: 2) {
                Text(connector.title)
                    .font(RelayFont.text(12, .medium))
                    .foregroundStyle(palette(.ink))
                if let detail = connector.detail {
                    Text(detail)
                        .font(RelayFont.text(11))
                        .foregroundStyle(palette(.muted))
                }
            }
        }
        .padding(.leading, 20)
        .frame(maxWidth: .infinity, minHeight: 83, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
