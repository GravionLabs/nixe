import { describe, expect, it } from "vitest";
import { errorText } from "./command-log";

describe("errorText", () => {
  it("turns any rejection into text", () => {
    expect(errorText("a")).toBe("a");
    expect(errorText(new Error("b"))).toBe("b");
    expect(errorText({ code: 1 })).toBe('{"code":1}');
  });
});
