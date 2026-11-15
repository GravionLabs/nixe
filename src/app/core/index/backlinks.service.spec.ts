import { Injector, signal } from "@angular/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { IndexStatus, backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { BacklinksService } from "./backlinks.service";
import { IndexService } from "./index.service";

const status = (state: IndexStatus["state"]): IndexStatus => ({ state, done: 0, total: 0, notes: 0, error: null });

function setup(indexState: IndexStatus["state"] = "ready") {
  const doc = { path: signal<string | null>("/vault/notes/A.md") };
  const workspace = { vaultRoot: signal<string | null>("/vault") };
  const index = { status: signal(status(indexState)), revision: signal(0) };
  const injector = Injector.create({
    providers: [
      { provide: DocumentService, useValue: doc },
      { provide: WorkspaceService, useValue: workspace },
      { provide: IndexService, useValue: index },
      { provide: BacklinksService, useClass: BacklinksService, deps: [] },
    ],
  });
  return { service: injector.get(BacklinksService), doc, workspace, index };
}

const back = {
  source: "B.md",
  heading: null,
  block: null,
  alias: null,
  kind: "link",
  line: 4,
  context: "see [[A]]",
};
const link = (target: string, resolved: string | null) => ({
  target,
  heading: null,
  block: null,
  alias: null,
  kind: "link",
  resolved,
  line: 2,
});

describe("BacklinksService", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.restoreAllMocks();
  });

  it("lists backlinks with their line and outgoing links, marking unresolved ones", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "backlinks"
        ? [back]
        : { path: "notes/A.md", title: "A", links: [link("sub/C", "sub/C.md"), link("Missing", null)] },
    );
    const { service } = setup();
    await service.refresh();
    expect(invoke).toHaveBeenCalledWith("backlinks", { path: "notes/A.md" });
    expect(service.state()).toBe("ready");
    expect(service.backlinks()).toEqual([back]);
    expect(service.outgoing().map((l) => [l.label, l.resolved])).toEqual([
      ["C", "sub/C.md"],
      ["Missing", null],
    ]);
    expect(service.unresolvedCount()).toBe(1);
  });

  it("is ready with empty lists when the note has no links", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "backlinks" ? [] : null));
    const { service } = setup();
    await service.refresh();
    expect(service.state()).toBe("ready");
    expect(service.backlinks()).toEqual([]);
    expect(service.outgoing()).toEqual([]);
  });

  it("shows loading and reads nothing while the index is still being built", async () => {
    const { service, index } = setup("scanning");
    await service.refresh();
    expect(service.state()).toBe("loading");
    expect(invoke).not.toHaveBeenCalled();
    index.status.set(status("ready"));
    expect(service.state()).toBe("ready");
  });

  it("follows navigation and index updates through its key", () => {
    const { service, doc, index } = setup();
    const before = service.key();
    doc.path.set("/vault/B.md");
    expect(service.notePath()).toBe("B.md");
    expect(service.key()).not.toBe(before);
    const mid = service.key();
    index.revision.update((n) => n + 1);
    expect(service.key()).not.toBe(mid);
  });

  it("is idle outside a vault and reports a failing index", async () => {
    const { service, workspace } = setup();
    workspace.vaultRoot.set(null);
    expect(service.state()).toBe("idle");
    workspace.vaultRoot.set("/vault");
    // Not through `invoke`: vitest reports a rejection of a mock's own result as unhandled.
    vi.spyOn(backend, "backlinks").mockImplementation(async () => {
      throw new Error("no vault is indexed yet");
    });
    vi.spyOn(backend, "noteMeta").mockResolvedValue(null);
    await service.refresh();
    expect(service.state()).toBe("error");
  });

  it("ignores the answer of an older request", async () => {
    let release: (v: unknown) => void = () => undefined;
    invoke.mockImplementationOnce(() => new Promise((r) => (release = r)));
    invoke.mockResolvedValue(null);
    const { service } = setup();
    const first = service.refresh();
    invoke.mockImplementation(async (cmd: string) => (cmd === "backlinks" ? [] : null));
    await service.refresh();
    release([back]);
    await first;
    expect(service.backlinks()).toEqual([]);
  });
});
