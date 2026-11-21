import { describe, expect, it } from "vitest";

import type { GitStatus } from "../file/backend";
import { syncSummary, timeAgo } from "./sync-summary";

const base: GitStatus = { branch: "main", changes: [], ahead: 0, behind: 0, hasRemote: true };
const NOW = 10_000_000;

describe("timeAgo", () => {
  it("counts minutes, hours and days", () => {
    expect(timeAgo(NOW - 20_000, NOW)).toBe("just now");
    expect(timeAgo(NOW - 60_000, NOW)).toBe("1 minute ago");
    expect(timeAgo(NOW - 5 * 60_000, NOW)).toBe("5 minutes ago");
    expect(timeAgo(NOW - 2 * 3_600_000, NOW)).toBe("2 hours ago");
    expect(timeAgo(NOW - 3 * 86_400_000, NOW)).toBe("3 days ago");
  });
});

describe("syncSummary", () => {
  it("says everything is synced, with the time of the last sync", () => {
    expect(syncSummary(base, NOW - 5 * 60_000, NOW)).toBe("Everything is synced · 5 minutes ago");
    expect(syncSummary(base, null, NOW)).toBe("Everything is synced");
  });

  it("counts the changes that are not saved yet", () => {
    const one = { ...base, changes: [{ path: "a.md", kind: "modified" as const }] };
    expect(syncSummary(one, null, NOW)).toBe("1 change not saved yet");
    const three = { ...one, changes: [...one.changes, ...one.changes, ...one.changes] };
    expect(syncSummary(three, null, NOW)).toBe("3 changes not saved yet");
  });

  it("counts the versions to send and to receive", () => {
    expect(syncSummary({ ...base, ahead: 2, behind: 1 }, null, NOW)).toBe(
      "2 versions to send, 1 to receive",
    );
    expect(syncSummary({ ...base, ahead: 1 }, null, NOW)).toBe("1 version to send");
    expect(syncSummary({ ...base, behind: 4 }, null, NOW)).toBe("4 to receive");
  });

  it("without a remote only knows whether it is saved", () => {
    expect(syncSummary({ ...base, hasRemote: false, ahead: 3 }, null, NOW)).toBe(
      "Everything is saved",
    );
  });
});
