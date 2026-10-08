// Text that several commands print.

// How long ago `then` was, rounded like git's relative dates: "45 seconds ago", "5 minutes ago",
// "2 hours ago", "3 days ago", "2 weeks ago", "4 months ago", "1 year ago".
export function timeAgo(then: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  const ago = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"} ago`;
  if (seconds < 90) return ago(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return ago(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 36) return ago(hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 14) return ago(days, "day");
  if (days < 70) return ago(Math.round(days / 7), "week");
  if (days < 365) return ago(Math.round(days / 30), "month");
  return ago(Math.round(days / 365), "year");
}
