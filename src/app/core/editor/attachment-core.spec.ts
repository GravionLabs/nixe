import { describe, expect, it } from "vitest";

import { embedFor, pastedImageName } from "./attachment-core";

describe("pastedImageName", () => {
  it("uses the local time as YYYYMMDDHHmmss", () => {
    expect(pastedImageName(new Date(2026, 2, 6, 4, 5, 9))).toBe("Pasted image 20260306040509.png");
  });

  it("takes the extension of the image type and falls back to png", () => {
    const date = new Date(2026, 0, 1, 0, 0, 0);
    expect(pastedImageName(date, "image/jpeg")).toBe("Pasted image 20260101000000.jpg");
    expect(pastedImageName(date, "image/x-unknown")).toBe("Pasted image 20260101000000.png");
  });
});

describe("embedFor", () => {
  it("embeds by name when the name is unique", () => {
    expect(embedFor("Assets/a.png", ["Assets/a.png", "n.md"])).toBe("![[a.png]]");
  });

  it("embeds by path when another file has the same name", () => {
    expect(embedFor("Assets/a.png", ["Assets/a.png", "Old/a.png"])).toBe("![[Assets/a.png]]");
  });
});
