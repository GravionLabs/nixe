// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

const template = readFileSync("src/app/features/sidebar/sidebar.component.html", "utf8");

describe("reveal the active note button", () => {
  let button: HTMLElement;
  let svg: SVGElement;

  beforeAll(() => {
    const host = document.createElement("div");
    host.innerHTML = template;
    button = host.querySelector('button[aria-label="Reveal the active note"]') as HTMLElement;
    svg = button.querySelector("svg") as SVGElement;
  });

  it("draws a target: one large ring, four ticks from the ring inwards, no centre dot", () => {
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    const circles = svg.querySelectorAll("circle");
    expect(circles).toHaveLength(1);
    expect(circles[0].getAttribute("r")).toBe("9");
    expect(circles[0].getAttribute("cx")).toBe("12");
    expect(circles[0].getAttribute("cy")).toBe("12");
    expect(svg.querySelectorAll("path")[0].getAttribute("d")).toBe(
      "M12 3v5M12 16v5M3 12h5M16 12h5",
    );
  });

  it("is stroke only and keeps tooltip, shortcut hint and label", () => {
    expect(svg.hasAttribute("fill")).toBe(false);
    expect(svg.querySelector("[stroke-width]")).toBeNull();
    expect(button.getAttribute("hx-tooltip")).toBe("Reveal the active note");
    expect(template).toContain("[hxTooltipShortcut]=\"shortcuts.keys('reveal-active-note')\"");
  });
});
