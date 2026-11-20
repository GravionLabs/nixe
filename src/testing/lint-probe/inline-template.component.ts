import { Component } from "@angular/core";

/** Lint probe (#273): an inline template outside a spec file fails component-max-inline-declarations. */
@Component({
  selector: "app-inline-template-probe",
  template: `<p>inline</p>`,
})
export class InlineTemplateProbe {}
