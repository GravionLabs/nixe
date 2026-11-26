// @vitest-environment jsdom
import "@angular/compiler";
import { Component, Input, TemplateRef } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it } from "vitest";

import { NavIconDirective } from "./nav-icon.directive";

// The specs compile with JIT, which does not register signal inputs: declare the one of the
// directive, as the compiler of the app does.
Input({ isSignal: true, alias: "appNavIcon" } as Input)(NavIconDirective.prototype, "name");

@Component({
  imports: [NavIconDirective],
  template: `
    <ng-template appNavIcon="files"><span>F</span></ng-template>
    <ng-template appNavIcon="search"><span>S</span></ng-template>
  `,
})
class HostComponent {}

describe("NavIconDirective", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("exposes the icon name and the template of each marked ng-template", () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    const icons = fixture.debugElement
      .queryAllNodes(By.directive(NavIconDirective))
      .map((node) => node.injector.get(NavIconDirective));
    expect(icons.map((icon) => icon.name())).toEqual(["files", "search"]);

    const text = icons.map((icon) => {
      expect(icon.template).toBeInstanceOf(TemplateRef);
      const view = icon.template.createEmbeddedView({});
      view.detectChanges();
      return (view.rootNodes[0] as HTMLElement).textContent;
    });
    expect(text).toEqual(["F", "S"]);
  });
});
