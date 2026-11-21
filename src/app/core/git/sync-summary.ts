import type { GitStatus } from "../file/backend";

const MINUTE = 60_000;

/** "just now", "5 minutes ago", "2 hours ago", "3 days ago". */
export function timeAgo(then: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - then) / MINUTE);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The state of the vault in one sentence, without Git terms. */
export function syncSummary(status: GitStatus, lastSynced: number | null, now: number): string {
  const unsaved = status.changes.length;
  if (unsaved > 0) return `${plural(unsaved, "change", "changes")} not saved yet`;
  if (!status.hasRemote) return "Everything is saved";
  const parts = [
    status.ahead > 0 ? `${plural(status.ahead, "version", "versions")} to send` : "",
    status.behind > 0 ? `${status.behind} to receive` : "",
  ].filter(Boolean);
  if (parts.length > 0) return parts.join(", ");
  return lastSynced === null
    ? "Everything is synced"
    : `Everything is synced · ${timeAgo(lastSynced, now)}`;
}
