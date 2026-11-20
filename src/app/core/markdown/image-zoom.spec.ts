// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { assetFilePath, decorateImages, imageNaturalSize, revealLabel } from "./image-zoom";

describe("assetFilePath", () => {
  it("reverses convertFileSrc on macOS/Linux", () => {
    expect(assetFilePath(`asset://localhost/${encodeURIComponent("/home/me/notes/a b.png")}`)).toBe(
      "/home/me/notes/a b.png",
    );
  });

  it("reverses convertFileSrc on Windows", () => {
    expect(assetFilePath(`http://asset.localhost/${encodeURIComponent("C:\\notes\\x.svg")}`)).toBe(
      "C:\\notes\\x.svg",
    );
  });

  it("has no file for remote, data and invalid sources", () => {
    expect(assetFilePath("https://example.com/a.png")).toBeNull();
    expect(assetFilePath("data:image/png;base64,AAAA")).toBeNull();
    expect(assetFilePath("not a url")).toBeNull();
    expect(assetFilePath(null)).toBeNull();
    expect(assetFilePath("asset://localhost/")).toBeNull();
  });
});

describe("revealLabel", () => {
  it("names the file manager of the platform", () => {
    expect(revealLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toBe("Reveal in Finder");
    expect(revealLabel("Mozilla/5.0 (Windows NT 10.0)")).toBe("Show in Explorer");
    expect(revealLabel("Mozilla/5.0 (X11; Linux)")).toBe("Show in file manager");
  });
});

describe("imageNaturalSize", () => {
  it("uses the natural size", () => {
    expect(
      imageNaturalSize({
        naturalWidth: 800,
        naturalHeight: 600,
        clientWidth: 100,
        clientHeight: 75,
      }),
    ).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("falls back to the shown size for an SVG without intrinsic size", () => {
    expect(
      imageNaturalSize({ naturalWidth: 0, naturalHeight: 0, clientWidth: 400, clientHeight: 200 }),
    ).toEqual({
      width: 400,
      height: 200,
    });
  });
});

describe("decorateImages", () => {
  it("makes a plain image focusable and leaves an image in a link to the link", () => {
    const root = document.createElement("div");
    root.innerHTML = `<p><img src="a.png" alt="A"></p><p><a href="x"><img src="b.png"></a></p>`;
    decorateImages(root);
    const [plain, linked] = Array.from(root.querySelectorAll("img"));
    expect(plain!.tabIndex).toBe(0);
    expect(plain!.hasAttribute("data-zoomable")).toBe(true);
    expect(plain!.getAttribute("aria-label")).toBe("Open image: A");
    expect(linked!.hasAttribute("data-zoomable")).toBe(false);
    expect(linked!.hasAttribute("tabindex")).toBe(false);
  });
});
