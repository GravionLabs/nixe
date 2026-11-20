import type { OnDestroy } from "@angular/core";
import { Component, EventEmitter, NgModule, Output } from "@angular/core";

/**
 * Lint probe (#273, ADR 0006 of GravionLabs/skills): every violation here is deliberate.
 * `src/testing/lint-probe.spec.ts` runs oxlint and ESLint on this folder and expects each rule, so a
 * broken oxlint JS plugin, a lost type-aware rule or a lost template rule fails a test instead of
 * passing silently. Left out of `pnpm lint` and of the build (tsconfig.app.json).
 */
@Component({
  // @angular-eslint/component-selector: not the app prefix.
  selector: "probe-component",
  // @angular-eslint/prefer-standalone
  standalone: false,
  templateUrl: "./probe.component.html",
})
export class ProbeComponent implements OnDestroy {
  // @angular-eslint/no-output-on-prefix
  @Output() readonly onPick = new EventEmitter<string>();
  // @angular-eslint/no-output-native
  @Output() readonly click = new EventEmitter<void>();

  value = "";

  // @angular-eslint/prefer-inject
  constructor(readonly doc: Document) {}

  // @angular-eslint/use-lifecycle-interface: no `implements OnInit`.
  ngOnInit(): void {
    // typescript/no-floating-promises (type-aware, oxlint-tsgolint)
    this.load();
  }

  // @angular-eslint/no-empty-lifecycle-method
  ngOnDestroy(): void {}

  pick(): void {
    this.onPick.emit("pick");
  }

  private async load(): Promise<void> {}
}

@NgModule({ declarations: [ProbeComponent] })
export class ProbeModule {}
