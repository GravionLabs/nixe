import { Directive } from "@angular/core";

/** Lint probe (#658): the class name without `Directive` fails directive-class-suffix. */
@Directive({ selector: "[appSuffixProbe]" })
export class SuffixProbe {}
