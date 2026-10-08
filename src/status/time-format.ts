// Times and ages in relay status (design.md decision 20), in local time. `now` comes from the
// program's clock, so tests can fix it.
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

// "14:30" on the same local day, "Thu 09:00" within 6 days before or after, else "Oct 12 09:00".
export function formatTime(time: Date, now: Date): string {
  const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}`;
  const days = Math.round((startOfDay(time) - startOfDay(now)) / DAY_MS);
  if (days === 0) return clock;
  if (Math.abs(days) <= 6) return `${DAYS[time.getDay()]} ${clock}`;
  return `${MONTHS[time.getMonth()]} ${time.getDate()} ${clock}`;
}

// "just now" under a minute, "<n> min ago" under an hour, "<n> h ago" under a day, then the date.
export function formatAge(time: Date, now: Date): string {
  const seconds = Math.max(0, (now.getTime() - time.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return formatTime(time, now);
}

function startOfDay(time: Date): number {
  return new Date(time.getFullYear(), time.getMonth(), time.getDate()).getTime();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
