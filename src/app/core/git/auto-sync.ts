/** Minutes allowed for the interval setting. */
export const AUTO_SYNC_MIN_MINUTES = 1;
export const AUTO_SYNC_MAX_MINUTES = 1440;
export const AUTO_SYNC_DEFAULT_MINUTES = 10;
/** How long the editor must be quiet before an automatic sync starts. */
export const AUTO_SYNC_IDLE_MS = 5000;

/** Clamps a user-entered interval to whole minutes in the allowed range. */
export function clampMinutes(value: number): number {
  if (!Number.isFinite(value)) return AUTO_SYNC_DEFAULT_MINUTES;
  return Math.min(AUTO_SYNC_MAX_MINUTES, Math.max(AUTO_SYNC_MIN_MINUTES, Math.round(value)));
}

/**
 * Decides when an automatic sync runs. A request (interval tick, focus) waits until there has
 * been no activity for `idleMs`, and never overlaps a running sync: a request that arrives
 * meanwhile is merged into one follow-up run.
 */
export class AutoSyncScheduler {
  private lastActivity = Number.NEGATIVE_INFINITY;
  private pending = false;
  private running = false;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private intervalTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = true;

  constructor(
    private readonly run: () => Promise<void>,
    private readonly idleMs: number = AUTO_SYNC_IDLE_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** (Re)starts the periodic requests; `intervalMs` null means no interval. */
  start(intervalMs: number | null): void {
    this.stop();
    this.stopped = false;
    if (intervalMs !== null) this.intervalTimer = setInterval(() => this.request(), intervalMs);
  }

  /** Drops the timers and any waiting request. A running sync is not interrupted. */
  stop(): void {
    this.stopped = true;
    this.pending = false;
    clearInterval(this.intervalTimer);
    clearTimeout(this.idleTimer);
    this.intervalTimer = undefined;
    this.idleTimer = undefined;
  }

  /** The user is typing or otherwise active. */
  activity(): void {
    this.lastActivity = this.now();
  }

  /** Asks for a sync; it starts once the editor has been idle. */
  request(): void {
    if (this.stopped) return;
    this.pending = true;
    this.attempt();
  }

  private attempt(): void {
    if (!this.pending || this.running || this.stopped) return;
    clearTimeout(this.idleTimer);
    const wait = this.lastActivity + this.idleMs - this.now();
    if (wait > 0) {
      this.idleTimer = setTimeout(() => this.attempt(), wait);
      return;
    }
    this.pending = false;
    this.running = true;
    void this.run()
      .catch(() => undefined)
      .finally(() => {
        this.running = false;
        this.attempt();
      });
  }
}
