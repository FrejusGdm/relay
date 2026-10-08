// The text of relay status (design.md decision 20, the status-command spec): the header, one lane
// per account, the closing sentence, and the saved-state line when the daemon did not answer.
// With `style`, the current row is bold and limited rows are dim; without it there is no escape
// sequence at all.
import { printable } from "../core/quote";
import { STALE_REASON } from "../state/availability";
import type { AccountView, UsageItem } from "../state/queries";
import type { StatusRow, StatusView } from "./model";
import { formatAge, formatTime } from "./time-format";

const LANE = 16;
const TITLE_MAX = 48;
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
export const SAVED_STATE_LINE = "Showing saved state. The relay daemon is not running.";

const WORDS: Record<string, string> = {
  available: "available",
  rate_limited: "limit reached",
  quota_exhausted: "out of quota",
  unavailable: "unavailable",
  unknown: "unknown",
};
const WINDOW_NAMES: Record<string, string> = { five_hour: "5-hour window", seven_day: "7-day window" };

export function renderText(view: StatusView, options: { now: Date; style: boolean }): string {
  const { job } = view;
  const { now, style } = options;
  const checkpoint =
    job.last_checkpoint === null
      ? "no checkpoint yet"
      : `checkpoint ${job.last_checkpoint.commit.slice(0, 6)} · ${formatAge(new Date(job.last_checkpoint.created_at), now)}`;
  const lines = [`${shortTitle(job.title)}   job ${job.id} · ${checkpoint}`, ""];

  const width = Math.max(17, ...view.rows.map((row) => [...row.account.target].length + 3));
  const hasPrevious = view.rows.some((row) => row.role === "previous");
  for (const row of view.rows) {
    let line = `${printable(row.account.target).padEnd(width)}${lane(row, hasPrevious)}   ${words(row, now)}`;
    if (style && row.role === "current") line = `${BOLD}${line}${RESET}`;
    else if (style && isLimited(row.account)) line = `${DIM}${line}${RESET}`;
    lines.push(line);
    if (row.role === "previous") lines.push(`${" ".repeat(width + 12)}│`);
  }

  lines.push("", view.closing);
  if (view.daemon === "not_running") lines.push("", SAVED_STATE_LINE);
  return `${lines.join("\n")}\n`;
}

function shortTitle(title: string): string {
  const characters = [...printable(title)];
  return characters.length > TITLE_MAX ? `${characters.slice(0, TITLE_MAX - 1).join("")}…` : characters.join("");
}

function lane(row: StatusRow, hasPrevious: boolean): string {
  if (row.role === "previous") return `${"─".repeat(12)}┐   `;
  if (row.role === "current") return hasPrevious ? `${"━".repeat(12)}┷${"━".repeat(3)}` : "━".repeat(LANE);
  return "─".repeat(LANE);
}

function isLimited(account: AccountView): boolean {
  return ["rate_limited", "quota_exhausted", "unavailable"].includes(account.availability.status);
}

// The row's state in words (design.md decision 19), then what relay knows about its limit or usage.
function words(row: StatusRow, now: Date): string {
  const { availability, usage } = row.account;
  if (row.activity !== "idle") return [row.activity, usageText(usage, now)].join(" · ");
  const word = WORDS[availability.status] ?? "unknown";
  if (availability.status === "rate_limited" || availability.status === "quota_exhausted") {
    const reset = availability.retry_at === null ? "reset unknown" : `resets ${formatTime(new Date(availability.retry_at), now)}`;
    return `${word} · ${reset}`;
  }
  if (availability.status === "unknown") {
    if (availability.reason === STALE_REASON) return `${word} · reset time passed`;
    if (availability.measured_at === null) return `${word} · not measured`;
  }
  return `${word} · ${usageText(usage, now)}`;
}

// Each measured window, narrowest first, or "usage unknown". Percentages are never added up.
function usageText(usage: UsageItem[], now: Date): string {
  const measured = usage
    .filter((item) => item.used_percent !== null)
    .sort((a, b) => (a.window_minutes ?? Infinity) - (b.window_minutes ?? Infinity));
  if (measured.length === 0) return "usage unknown";
  return measured
    .map((item) => {
      const checked = item.measured_at === null ? "" : `, checked ${formatTime(new Date(item.measured_at), now)}`;
      return `${Math.round(item.used_percent!)}% used (${windowName(item)}${checked})`;
    })
    .join(" · ");
}

function windowName(item: UsageItem): string {
  if (WINDOW_NAMES[item.window] !== undefined) return WINDOW_NAMES[item.window]!;
  if (item.window_minutes !== null && item.window_minutes > 0) return `${Math.round(item.window_minutes / 60)}-hour window`;
  return "usage window";
}
