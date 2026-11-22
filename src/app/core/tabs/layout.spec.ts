import { describe, expect, it } from "vitest";

import { clampRatio, layoutHasNote, sanitizeLayout } from "./layout";

const tab = {
  view: null,
  path: "/v/a.md",
  history: ["/v/a.md"],
  index: 0,
  editing: false,
  line: 3,
  preview: false,
};

describe("sanitizeLayout", () => {
  it("keeps a valid layout", () => {
    const layout = { panes: [{ tabs: [tab], active: 0 }], focused: 0, ratio: 0.4 };
    expect(sanitizeLayout(layout)).toEqual(layout);
  });

  it("keeps the preview mark of a note tab and reads an older layout as pinned", () => {
    const layout = (t: object) =>
      sanitizeLayout({ panes: [{ tabs: [t], active: 0 }], focused: 0, ratio: 0.5 })!;
    expect(layout({ ...tab, preview: true }).panes[0].tabs[0].preview).toBe(true);
    expect(layout({ ...tab, preview: "yes" }).panes[0].tabs[0].preview).toBe(false);
    const { preview: _, ...old } = tab;
    expect(layout(old).panes[0].tabs[0].preview).toBe(false);
    expect(layout({ view: "health", preview: true }).panes[0].tabs[0].preview).toBe(false);
  });

  it("rejects what is not a layout", () => {
    for (const value of [
      null,
      3,
      "x",
      [],
      {},
      { panes: "x" },
      { panes: [] },
      { panes: [{ tabs: [] }] },
    ]) {
      expect(sanitizeLayout(value)).toBeNull();
    }
  });

  it("keeps at most two panes and clamps indexes and the ratio", () => {
    const pane = { tabs: [tab, tab], active: 9 };
    const layout = sanitizeLayout({ panes: [pane, pane, pane], focused: -4, ratio: 7 })!;
    expect(layout.panes.length).toBe(2);
    expect(layout.panes[0].active).toBe(1);
    expect(layout.focused).toBe(0);
    expect(layout.ratio).toBe(0.85);
  });

  it("drops tabs of the wrong shape and repairs the fields of the others", () => {
    const layout = sanitizeLayout({
      panes: [
        {
          tabs: [
            7,
            { path: 5 },
            { path: "/v/b.md", history: ["/v/b.md", 3, ""], index: 40, editing: "yes", line: 0 },
          ],
          active: 0,
        },
      ],
    })!;
    expect(layout.panes[0].tabs).toEqual([
      {
        view: null,
        path: null,
        history: [],
        index: -1,
        editing: false,
        line: null,
        preview: false,
      },
      {
        view: null,
        path: "/v/b.md",
        history: ["/v/b.md"],
        index: 0,
        editing: false,
        line: null,
        preview: false,
      },
    ]);
  });

  it("keeps a known view without a note or a history, and drops an unknown one", () => {
    const layout = sanitizeLayout({
      panes: [
        {
          tabs: [
            { view: "health", path: "/v/a.md", history: ["/v/a.md"], editing: true },
            { view: "nope" },
          ],
          active: 0,
        },
      ],
    })!;
    expect(layout.panes[0].tabs).toEqual([
      {
        view: "health",
        path: null,
        history: [],
        index: -1,
        editing: false,
        line: null,
        preview: false,
      },
      {
        view: null,
        path: null,
        history: [],
        index: -1,
        editing: false,
        line: null,
        preview: false,
      },
    ]);
  });

  it("does not restore the editor of an empty tab", () => {
    const layout = sanitizeLayout({
      panes: [{ tabs: [{ path: null, editing: true }], active: 0 }],
    })!;
    expect(layout.panes[0].tabs[0].editing).toBe(false);
  });
});

describe("layout helpers", () => {
  it("tells whether a note is shown", () => {
    const empty = {
      view: null,
      path: null,
      history: [],
      index: -1,
      editing: false,
      line: null,
      preview: false,
    };
    expect(layoutHasNote({ panes: [{ tabs: [empty], active: 0 }], focused: 0, ratio: 0.5 })).toBe(
      false,
    );
    expect(
      layoutHasNote({ panes: [{ tabs: [empty, tab], active: 0 }], focused: 0, ratio: 0.5 }),
    ).toBe(true);
  });

  it("counts a view tab as something to restore", () => {
    const view = { ...tab, view: "settings" as const, path: null, history: [], index: -1 };
    expect(layoutHasNote({ panes: [{ tabs: [view], active: 0 }], focused: 0, ratio: 0.5 })).toBe(
      true,
    );
  });

  it("clamps the ratio", () => {
    expect(clampRatio(0.5)).toBe(0.5);
    expect(clampRatio(0)).toBe(0.15);
    expect(clampRatio(Number.POSITIVE_INFINITY)).toBe(0.5);
  });
});
