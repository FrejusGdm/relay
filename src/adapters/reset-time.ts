// Reads the reset time of a usage limit (add-provider-adapters, design decision 8). Structured
// fields give a number or an ISO 8601 string; limit messages give a local time such as "3:45pm",
// "Mon 12:00am" or "Oct 9, 3:45 PM", which means the next time the clock shows it. Codex writes a
// reset on another day as "Oct 9th, 2026 3:45 PM", with the year.
import { now } from "../platform/clock";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T|$)/;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const LOCAL_TIME = new RegExp(
  "^(?:(?<weekday>" + WEEKDAYS.join("|") + ")\\s+|(?<month>" + MONTHS.join("|") + ")\\s+(?<day>\\d{1,2})(?:st|nd|rd|th)?,?\\s+(?:(?<year>\\d{4}),?\\s+)?)?" +
    "(?<hour>\\d{1,2})(?::(?<minute>\\d{2}))?\\s*(?<half>am|pm)$",
  "i",
);

// A number below 10^12 is Unix seconds and a larger one Unix milliseconds, because the unit of
// Claude Code's resetsAt is not documented. Anything else that is not an ISO 8601 time gives
// undefined.
export function resetTimeFromValue(value: unknown): Date | undefined {
  let time = Number.NaN;
  if (typeof value === "number" && value > 0) time = value < 1e12 ? value * 1000 : value;
  else if (typeof value === "string" && ISO_DATE.test(value)) time = Date.parse(value);
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

// Reads the time part of a limit message, after "resets" or "try again at", as the next moment
// after `after` when the local clock shows it. A final full stop and a time zone name in
// parentheses are ignored. Returns undefined for text in another form.
export function resetTimeFromText(text: string, after: Date = now()): Date | undefined {
  const cleaned = text.trim().replace(/\.$/, "").replace(/\s*\([^)]*\)$/, "").replace(/\.$/, "").trim();
  const parts = LOCAL_TIME.exec(cleaned)?.groups;
  if (parts === undefined) return undefined;
  const hour = Number(parts.hour);
  const minute = parts.minute === undefined ? 0 : Number(parts.minute);
  if (hour < 1 || hour > 12 || minute > 59) return undefined;
  const hours = (hour % 12) + (parts.half!.toLowerCase() === "pm" ? 12 : 0);

  if (parts.month !== undefined) {
    const month = MONTHS.indexOf(parts.month.toLowerCase());
    const day = Number(parts.day);
    const years = parts.year === undefined ? [after.getFullYear(), after.getFullYear() + 1] : [Number(parts.year)];
    for (const year of years) {
      const candidate = new Date(year, month, day, hours, minute);
      if (candidate.getMonth() !== month || candidate.getDate() !== day) return undefined;
      if (candidate > after || parts.year !== undefined) return candidate;
    }
    return undefined;
  }

  const weekday = parts.weekday === undefined ? null : WEEKDAYS.indexOf(parts.weekday.toLowerCase());
  for (let days = 0; days <= 7; days++) {
    const candidate = new Date(after.getFullYear(), after.getMonth(), after.getDate() + days, hours, minute);
    if (candidate > after && (weekday === null || candidate.getDay() === weekday)) return candidate;
  }
  return undefined;
}

// Like resetTimeFromText, but a time zone named in parentheses, as in "6:50pm (Europe/Berlin)",
// is honoured: the time is read as that zone's clock (add-resume-at-reset). Text without a zone,
// or with a name the system does not know, is read as local time.
export function resetTimeInZone(text: string, after: Date = now()): Date | undefined {
  const zone = /\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\)\s*\.?\s*$/.exec(text.trim())?.[1];
  if (zone === undefined || !knownZone(zone)) return resetTimeFromText(text, after);
  // The zone's clock at `after`, as a local date, so the local reading finds the next moment that
  // clock shows the time; its fields are then read back as the zone's clock.
  const shifted = new Date(after.getTime() + (offsetMs(after, zone) - localOffsetMs(after)));
  const wall = resetTimeFromText(text, shifted);
  if (wall === undefined) return undefined;
  const guess = Date.UTC(wall.getFullYear(), wall.getMonth(), wall.getDate(), wall.getHours(), wall.getMinutes());
  const first = guess - offsetMs(new Date(guess), zone);
  return new Date(guess - offsetMs(new Date(first), zone));
}

function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// How far the zone's clock is ahead of UTC at `at`, in milliseconds.
function offsetMs(at: Date, zone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at).map((part) => [part.type, part.value]));
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

function localOffsetMs(at: Date): number {
  return -at.getTimezoneOffset() * 60_000;
}
