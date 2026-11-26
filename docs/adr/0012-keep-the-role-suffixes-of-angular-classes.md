# ADR 0012: Keep the role suffixes of Angular classes

- Status: Proposed
- Date: 2026-11-26
- Issues: #657 (follow-ups #658, #659); GravionLabs/skills#1019

## Context

Since Angular 20 the style guide and the CLI drop role suffixes: `ng generate component editor`
writes `editor.ts` with the class `Editor`. Older projects keep them through `schematics` settings
in `angular.json` that `ng update` writes. Suffixes are not deprecated; both styles build and run.

Nixe was created on Angular 22.0.1, but its first commit already used suffixes
(`app.component.ts`, `document.service.ts`), and new code followed the files that were there. Today
it has 50 `*.component.ts` with `…Component` and 50 `*.service.ts` with `…Service`. The choice was
never recorded, and nothing enforces it:

- `angular.json` declares no `type` or `typeSeparator`, so `ng generate` writes suffixless files
  into a suffixed project.
- No lint rule checks the class suffix.
- A few classes already drifted: `NavIconDirective` lives in `app.component.ts`; `CommandRegistry`,
  `SettingsRegistry` and `TerminalBackend` are `@Injectable` without `Service`.

A switch to suffixless names would rename about 265 files and touch about 1 900 class references
in about 195 files, and it would conflict with every open pull request. It is no plain search and
replace: 21 base names are both a component and a service (`Editor`, `Search`, `Settings`,
`Workspace`, `Git`, `History`, `Review`, …), `DocumentService` and `HistoryService` would shadow the
DOM types `Document` and `History`, and three folders already hold a file of the suffixless name
(`core/compare/compare.ts`, `core/epub/epub.ts`, `core/git/auto-sync.ts`).

## Decision

Nixe keeps the role suffixes, as a declared convention:

- A component is `<name>.component.ts` (with `.html`, `.css`, `.spec.ts` of the same base name)
  and the class `<Name>Component`; a directive `<name>.directive.ts` / `<Name>Directive`; an
  `@Injectable` that is a service `<name>.service.ts` / `<Name>Service`; pipes, guards, resolvers
  and interceptors `<name>.<type>.ts` if they appear.
- One Angular class per file.
- An `@Injectable` whose name already says its role may keep it without `Service`: `…Registry`
  (`CommandRegistry`, `SettingsRegistry`) and `…Backend` (`TerminalBackend`, a seam that specs
  replace with a fake). New exceptions are added to this list, not invented in passing.
- `angular.json` declares the convention, as `ng update` writes it for suffixed projects:
  `@schematics/angular:component|directive|service` with `type`,
  `@schematics/angular:guard|interceptor|module|pipe|resolver` with `typeSeparator: "."` (#658).
- oxlint enforces the class suffix of components and directives with
  `@angular-eslint/component-class-suffix` and `@angular-eslint/directive-class-suffix`, with a
  probe in `src/testing/lint-probe/` (#658). Service names have no lint rule; the review checks
  them.
- `NavIconDirective` moves into its own `nav-icon.directive.ts` (#659).

## Consequences

- `ng generate` and the existing code agree; agents and the `ng-implementation` skill read the
  convention from `angular.json` (GravionLabs/skills#1019) instead of guessing it from the files.
- The code stays apart from the current Angular style guide and from new Angular examples, which
  are suffixless; names are longer.
- The class name tells the role, which keeps the component and the service of the same feature
  (`EditorComponent`, `EditorService`) apart without new names.
- A later switch stays possible and gets no cheaper: it needs its own ADR that supersedes this one,
  intent names for the collisions above, and one refactor per area at a time with few open pull
  requests (right after a release). Reconsider it when Angular tooling starts to depend on the
  suffixless form, or when most of the code is rewritten anyway.

## Alternatives

- **Switch to suffixless names now.** Matches the style guide and the CLI default. Rejected for
  now: the renames and collisions above cost much and conflict with all open work, and the switch
  brings no functional gain.
- **Leave it undeclared.** Costs nothing today, but `ng generate` keeps mixing both styles and the
  drift grows unnoticed.
- **Suffixless only for new code.** Mixes both styles in one project, which makes names harder to
  guess and is what the declaration is meant to stop.
