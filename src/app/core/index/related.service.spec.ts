import { Injector, signal } from "@angular/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { backend } from "../file/backend";
import { BacklinksService } from "./backlinks.service";
import { IndexService } from "./index.service";
import { RelatedService } from "./related.service";

const found = [{ path: "B.md", title: "B", score: 60, reasons: ["links here"] }];

function setup(path: string | null, state: string) {
  const notePath = signal(path);
  const status = signal({ state });
  const injector = Injector.create({
    providers: [
      { provide: BacklinksService, useValue: { notePath, key: signal("k") } },
      { provide: IndexService, useValue: { status } },
      { provide: RelatedService, useClass: RelatedService, deps: [] },
    ],
  });
  return { service: injector.get(RelatedService), notePath, status };
}

describe("RelatedService", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("reads the related notes of the open note", async () => {
    const spy = vi.spyOn(backend, "relatedNotes").mockResolvedValue(found);
    const { service } = setup("A.md", "ready");
    expect(service.state()).toBe("ready");
    await service.refresh();
    expect(spy).toHaveBeenCalledWith("A.md");
    expect(service.notes()).toEqual(found);
  });

  it("reads nothing outside a note or while the index is not ready", async () => {
    const spy = vi.spyOn(backend, "relatedNotes").mockResolvedValue(found);
    expect(setup(null, "ready").service.state()).toBe("idle");
    const { service } = setup("A.md", "scanning");
    expect(service.state()).toBe("loading");
    await service.refresh();
    expect(spy).not.toHaveBeenCalled();
    expect(service.notes()).toEqual([]);
  });

  it("reports an error and recovers on the next read", async () => {
    const spy = vi.spyOn(backend, "relatedNotes").mockRejectedValueOnce(new Error("x"));
    const { service } = setup("A.md", "ready");
    await service.refresh();
    expect(service.state()).toBe("error");
    spy.mockResolvedValue(found);
    await service.refresh();
    expect(service.state()).toBe("ready");
    expect(service.notes()).toEqual(found);
  });

  it("lets a newer read win over an older one still running", async () => {
    let release!: (v: typeof found) => void;
    const spy = vi
      .spyOn(backend, "relatedNotes")
      .mockImplementationOnce(() => new Promise((r) => (release = r)));
    const { service } = setup("A.md", "ready");
    const first = service.refresh();
    spy.mockResolvedValue([]);
    await service.refresh();
    release(found);
    await first;
    expect(service.notes()).toEqual([]);
  });
});
