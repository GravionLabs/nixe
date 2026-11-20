/** True for a pre-release version such as `1.2.0-rc011`. */
export function isPrerelease(version: string): boolean {
  return version.replace(/^v/, "").split("+")[0].includes("-");
}

/** A stable install is never offered a pre-release (rc); a pre-release install is offered both. */
export function isOfferable(current: string, candidate: string): boolean {
  return !isPrerelease(candidate) || isPrerelease(current);
}

/** The step that failed, named in the message. */
export type UpdateStep = "check" | "update";

const STEP_TEXT: Record<UpdateStep, string> = {
  check: "Check for updates failed",
  update: "Update failed",
};

export function failureMessage(step: UpdateStep, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return detail ? `${STEP_TEXT[step]}: ${detail}` : STEP_TEXT[step];
}

/** Download progress in percent, or null while the size is unknown. */
export function downloadPercent(received: number, total: number | null): number | null {
  return total && total > 0 ? Math.min(100, Math.floor((received * 100) / total)) : null;
}
