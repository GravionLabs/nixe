// @vitest-environment jsdom
/* oxlint-disable typescript/no-explicit-any -- the spec calls private members of the components through a stand-in `this` */
import "@angular/compiler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Set<string>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: { path?: string }) =>
    cmd === "is_file" ? files.has(args.path ?? "") : undefined,
  ),
}));
const openPath = vi.fn();
const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: (p: string) => openPath(p),
  openUrl: (u: string) => openUrl(u),
  revealItemInDir: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));

import { isEpubPath, isRemoteEpubUrl } from "../../core/markdown/paths";
import { EditorComponent } from "../editor/editor.component";
import { ViewerComponent } from "../viewer/viewer.component";

describe("isEpubPath", () => {
  it("is true for .epub in any case, false for other files", () => {
    expect(isEpubPath("/v/Books/A.epub")).toBe(true);
    expect(isEpubPath("/v/Books/A.EPUB")).toBe(true);
    expect(isEpubPath("/v/Books/A.pdf")).toBe(false);
    expect(isEpubPath("/v/Books/epub")).toBe(false);
  });
});

describe("isRemoteEpubUrl", () => {
  it("is true for an https URL whose path ends in .epub, query and fragment aside", () => {
    expect(isRemoteEpubUrl("https://example.org/b/Book.epub")).toBe(true);
    expect(isRemoteEpubUrl("https://example.org/b/Book.EPUB?dl=1#x")).toBe(true);
    expect(isRemoteEpubUrl("http://example.org/Book.epub")).toBe(false);
    expect(isRemoteEpubUrl("https://example.org/page?file=Book.epub")).toBe(false);
    expect(isRemoteEpubUrl("https://example.org/Book.pdf")).toBe(false);
    expect(isRemoteEpubUrl("ftp://example.org/Book.epub")).toBe(false);
    expect(isRemoteEpubUrl("not a url")).toBe(false);
  });
});

/** A stand-in `this`: the members the code reads, and the methods of the component's prototype. */
function stand(over: Record<string, unknown> = {}, component: any = ViewerComponent) {
  const self: any = Object.create(component.prototype);
  Object.assign(self, {
    notify: { emit: vi.fn() },
    failed: { emit: vi.fn() },
    tabs: { openEpub: vi.fn(async () => undefined), openPreview: vi.fn(), openInNewTab: vi.fn() },
    doc: { path: () => "/v/note.md", wikiRoot: () => "/v" },
    session: { path: "/v/note.md" },
    workspaces: { resolveLink: vi.fn(async () => undefined) },
    workspace: {
      vaultRoot: () => "/v",
      vaultFiles: () => ["note.md", "Books/Title.epub", "x.pdf"],
    },
    ops: { createNoteForLink: vi.fn(async () => null) },
    settle: vi.fn(async () => undefined),
    ...over,
  });
  return self;
}

async function click(self: any, href: string): Promise<void> {
  const a = document.createElement("a");
  a.setAttribute("href", href);
  document.body.append(a);
  const event = { target: a, preventDefault: vi.fn(), metaKey: false, ctrlKey: false };
  await (ViewerComponent.prototype as any).onClick.call(self, event);
}

beforeEach(() => {
  files.clear();
  openPath.mockClear();
  openUrl.mockClear();
});

describe("a link to an .epub in the viewer", () => {
  it("opens the reader for a relative Markdown link", async () => {
    files.add("/v/Books/Title.epub");
    const self = stand();
    await click(self, "Books/Title.epub");
    expect(self.tabs.openEpub).toHaveBeenCalledWith("/v/Books/Title.epub");
    expect(openPath).not.toHaveBeenCalled();
  });

  it("says the file is not found for a missing book, as for a note", async () => {
    const self = stand();
    await click(self, "Books/Gone.epub");
    expect(self.notify.emit).toHaveBeenCalledWith("File not found: Books/Gone.epub");
    expect(self.tabs.openEpub).not.toHaveBeenCalled();
  });

  it("still opens other files in the system app", async () => {
    files.add("/v/x.pdf");
    const self = stand();
    await click(self, "x.pdf");
    expect(openPath).toHaveBeenCalledWith("/v/x.pdf");
    expect(self.tabs.openEpub).not.toHaveBeenCalled();
  });

  it("opens the reader for a wikilink with a root prefix", async () => {
    const self = stand();
    self.workspaces.resolveLink = vi.fn(async () => "/books/Title.epub");
    await (ViewerComponent.prototype as any).openWikilink.call(self, "Books:Title.epub", false);
    expect(self.tabs.openEpub).toHaveBeenCalledWith("/books/Title.epub");
    expect(self.tabs.openPreview).not.toHaveBeenCalled();
  });

  it("opens the reader for a wikilink into the vault", async () => {
    const self = stand();
    await (ViewerComponent.prototype as any).openWikilink.call(self, "Title.epub", false);
    expect(self.tabs.openEpub).toHaveBeenCalledWith("/v/Books/Title.epub");
  });

  it("reports a missing book of a wikilink and creates no note", async () => {
    const self = stand();
    self.workspaces.resolveLink = vi.fn(async () => null);
    await (ViewerComponent.prototype as any).openWikilink.call(self, "Books:Gone.epub", false);
    await (ViewerComponent.prototype as any).openWikilink.call(
      stand({
        workspaces: { resolveLink: async () => undefined },
        ops: self.ops,
        notify: self.notify,
      }),
      "Gone.epub",
      false,
    );
    expect(self.notify.emit).toHaveBeenCalledTimes(2);
    expect(self.notify.emit).toHaveBeenCalledWith("File not found: Gone.epub");
    expect(self.ops.createNoteForLink).not.toHaveBeenCalled();
  });

  it("shows the error of a book that cannot be read", async () => {
    const self = stand();
    self.tabs.openEpub = vi.fn(async () => {
      throw new Error("broken");
    });
    await (ViewerComponent.prototype as any).openBook.call(self, "/v/Books/Title.epub");
    expect(self.notify.emit).toHaveBeenCalledWith("Error: broken");
  });
});

describe("a link to an https .epub", () => {
  it("opens the book in the reader instead of the browser (viewer)", async () => {
    const self = stand();
    await click(self, "https://example.org/Book.epub");
    expect(self.tabs.openEpub).toHaveBeenCalledWith("https://example.org/Book.epub");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("leaves other web links to the browser (viewer)", async () => {
    const self = stand();
    await click(self, "https://example.org/page");
    expect(self.tabs.openEpub).not.toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledWith("https://example.org/page");
  });

  it("shows the refusal of the download (viewer)", async () => {
    const self = stand();
    self.tabs.openEpub = vi.fn(async () => {
      throw "book too large";
    });
    await click(self, "https://example.org/Book.epub");
    expect(self.notify.emit).toHaveBeenCalledWith("book too large");
  });

  it("opens the book in the reader (editor)", async () => {
    const self = stand({}, EditorComponent);
    await (EditorComponent.prototype as any).openLink.call(
      self,
      { kind: "link", target: "https://example.org/Book.epub" },
      false,
    );
    expect(self.tabs.openEpub).toHaveBeenCalledWith("https://example.org/Book.epub");
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe("a link to an .epub in the editor", () => {
  const proto = EditorComponent.prototype as any;

  it("opens the reader for a Markdown link and a wikilink", async () => {
    files.add("/v/Books/Title.epub");
    const self = stand({}, EditorComponent);
    await proto.openLink.call(self, { kind: "link", target: "Books/Title.epub" }, false);
    expect(self.tabs.openEpub).toHaveBeenCalledWith("/v/Books/Title.epub");

    const wiki = stand({}, EditorComponent);
    wiki.workspaces.resolveLink = vi.fn(async () => "/books/Title.epub");
    await proto.openLink.call(wiki, { kind: "wikilink", target: "Books:Title.epub" }, false);
    expect(wiki.tabs.openEpub).toHaveBeenCalledWith("/books/Title.epub");
  });

  it("reports a missing book", async () => {
    const self = stand({}, EditorComponent);
    await proto.openLink.call(self, { kind: "link", target: "Books/Gone.epub" }, false);
    expect(self.failed.emit).toHaveBeenCalledWith("File not found: Books/Gone.epub");
  });
});
