import { Directive, TemplateRef, inject, input } from "@angular/core";

/** Marks the template of an activity bar icon with the icon name of the views registry. */
@Directive({ selector: "ng-template[appNavIcon]" })
export class NavIconDirective {
  readonly name = input.required<string>({ alias: "appNavIcon" });
  readonly template = inject(TemplateRef);
}
