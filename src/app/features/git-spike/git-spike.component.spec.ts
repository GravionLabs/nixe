import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { GitSpikeComponent } from "./git-spike.component";

describe("GitSpikeComponent", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  function create() {
    return { componentInstance: new GitSpikeComponent() };
  }

  it("clones into the vault directory and logs the duration", async () => {
    invoke.mockResolvedValue(42);
    const fixture = create();
    await (fixture.componentInstance as any).run("clone", () => (fixture.componentInstance as any).clone("u"));
    expect(invoke).toHaveBeenCalledWith("git_clone", { url: "u" });
    expect(fixture.componentInstance["log"]()).toContain("clone took 42 ms");
  });

  it("logs a failure instead of throwing", async () => {
    invoke.mockImplementation(async () => { throw new Error("bad credentials"); });
    const fixture = create();
    const c = fixture.componentInstance as any;
    await c.run("push", () => c.cmd("git_push"));
    expect(fixture.componentInstance["log"]()).toContain("push: FAILED Error: bad credentials");
  });
});
