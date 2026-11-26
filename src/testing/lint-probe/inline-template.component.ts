import { Component } from "@angular/core";

/**
 * Lint probe: an inline template outside a spec file fails component-max-inline-declarations (#273),
 * and the class name without `Component` fails component-class-suffix (#658).
 */
@Component({
  selector: "app-inline-template-probe",
  template: `<p>inline</p>`,
})
export class InlineTemplateProbe {}
