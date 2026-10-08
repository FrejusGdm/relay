// Reads the reset time of a usage limit (add-provider-adapters, design decision 8). Structured
// fields give a number or an ISO 8601 string; limit messages give a local time such as "3:45pm",
// "Mon 12:00am" or "Oct 9, 3:45 PM", which means the next time the clock shows it.
import { now } from "../platform/clock";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T|$)/;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const LOCAL_TIME = new RegExp(
  "^(?:(?<weekday>" + WEEKDAYS.join("|") + ")\\s+|(?<month>" + MONTHS.join("|") + ")\\s+(?<day>\\d{1,2}),?\\s+)?" +
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
    for (const year of [after.getFullYear(), after.getFullYear() + 1]) {
      const candidate = new Date(year, month, day, hours, minute);
      if (candidate.getMonth() !== month || candidate.getDate() !== day) return undefined;
      if (candidate > after) return candidate;
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
