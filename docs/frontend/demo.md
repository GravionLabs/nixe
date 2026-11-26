# Demo build, e2e tests and screenshots

The app also runs in a plain browser, without Tauri and without the Rust core. That build serves
three things: the Playwright e2e tests (`pnpm e2e`), the screenshots for the docs and the site
(`pnpm screenshots`) and a quick look at a change (`pnpm start:demo`, port 1422).

## How the build works

`pnpm start:demo` runs `ng serve --configuration demo`. `tsconfig.demo.json` maps every
`@tauri-apps/*` module to a stand-in in `src/demo/tauri/` (`core.ts`, `event.ts`, `dialog.ts`,
`window.ts`, …). The stand-ins forward `invoke` and `listen` to a `DemoBackend`. The production
build excludes `src/demo`.

| Path | What it holds |
| --- | --- |
| `src/demo/tauri/` | The stand-ins of the `@tauri-apps/*` modules. |
| `src/demo/kit/backend.ts` | `DemoBackend`: the answer registry, the event emitter, the `Channel` stand-in and the failure on a command nobody answered. It imports nothing from the app. |
| `src/demo/kit/fake.ts` | `createFakeBackend(answers)`: the scripted variant, see below. |
| `src/demo/nixe/` | The answers of Nixe: `demo.ts` (the table), `data.ts` (fixed notes and a fixed clock), `vault.ts` (the in-memory vault), `git.ts` (a seeded Git history, open changes, a branch to review), `excluded.ts`. |
| `src/demo/e2e/` | Vitest specs that call the typed wrappers of the app against the demo backend, per area (Git view, History, Settings). |
| `e2e/` | The Playwright tests and their steps. |

### `DemoBackend`

`DemoBackend.invoke(command, args)` records the call in `window.__demoCalls`, then runs the answer
registered for the command. A command without an answer throws `UnansweredCommandError`, logs a
`console.error` and appends its name to `window.__demoFailures`. A new feature that calls a new
command therefore turns an e2e test red; it never shows a silent, empty panel.

Two registrations exist: `backend.fixed({ command: value })` answers with a copy of a value,
`backend.answer({ command: (args, backend) => … })` computes the answer from the arguments (and may
push an event with `backend.emit`).

### Add the answer for a new command

1. Add the command to `core/file/backend.ts` or `core/terminal/terminal-backend.ts` as usual.
2. In `src/demo/nixe/demo.ts` answer it: a constant in `backend.fixed({…})`, or a function in
   `backend.answer({…})` that works on `vault`, `git` or the other in-memory state. Put new data in
   `data.ts` so the notes and the clock stay fixed.
3. A command that cannot make sense in a browser (it writes to a disk, needs a network, rewrites
   notes in the Rust core) goes to `src/demo/nixe/excluded.ts` instead, with its reason.
4. Run `pnpm test`. `src/demo/nixe/demo.spec.ts` fails when a command is neither answered nor
   excluded, when an excluded command is answered after all and when `excluded.ts` names a command
   the app no longer has.
5. Add a spec to `src/demo/e2e/` for an answer with logic (the Git history, the workspaces).

## The two variants

| | Demo (default) | Fake (`?backend=fake`) |
| --- | --- | --- |
| Answers | The whole seeded vault of `src/demo/nixe/`. | Only what the test gives. Every other command fails the test by name. |
| Use it for | Smoke tests of whole views and the screenshots. | Interaction tests that assert an action by the call it made. |
| Example | `e2e/smoke.e2e.ts` | `e2e/interaction.e2e.ts`, answers in `e2e/fake-vault.ts` |

The fake variant takes its answers from `window.__demoScript` (an init script, which `ready` sets
from its `script` option) and from `window.__demo.answer(command, value)` at runtime.
`window.__demo.emit(event, payload)` pushes an event and `window.__demo.calls(command?)` lists the
recorded calls.

Use the **demo** variant when the test only needs the app to show something realistic: it starts, a
note opens, a panel lists the links. Use the **fake** variant when the test must prove that an action
reached the backend (`write_text_file` with this content) or when it needs a state the seeded vault
does not have: a test lists what it needs, so a command it did not expect fails it.

## Add an e2e test

1. Put the test in `e2e/<area>.e2e.ts` and import `test` and `expect` from `./fixtures`, not from
   `@playwright/test`. The fixture fails every test on a `pageerror`, a `console.error` or an entry
   of `window.__demoFailures`.
2. Start with `await ready(page)` (demo) or `await ready(page, { fake: true, script: FAKE_VAULT })`
   (fake; add the commands your test needs to a copy of `FAKE_VAULT`).
3. Use the steps of `e2e/steps.ts` (`openNote`, `openPalette`, `openSearch`, `toggleBacklinks`, …)
   and add a new one there when two tests or a screenshot need it.
4. Select by role and name, as a user sees the page. Wait on a condition (`expect`, `expect.poll`):
   the oxlint rule `nixe-e2e/no-wait-for-timeout` rejects `waitForTimeout`.
5. Assert an action on the fake variant with `takeCalls(page, "command")`:

```ts
await expect
  .poll(async () => (await takeCalls(page, "write_text_file")).at(-1)?.args)
  .toEqual({ path: FAKE_NOTE, content: expect.stringContaining("Added by the test.") });
```

## Run the tests

`pnpm e2e` runs `playwright test` (`playwright.config.ts`) against the demo dev server (it starts
`pnpm start:demo` or reuses a running one) in Chromium, in a light and a dark project, with reduced
motion. The first run needs `pnpm exec playwright install chromium`. CI runs the `e2e` job on pull
requests as advisory (it is not part of the `needs` of `ci`); a failed run uploads the report and the
traces.

## Screenshots

`pnpm screenshots [name...] [--out <dir>]` writes `<name>-light.png` and `<name>-dark.png`
(default folder `site/public/screenshots`). `scripts/browser/playwright.mjs` installs Chromium when
it is missing, starts the demo server (or reuses the running one) and opens a page per theme with a
fixed clock, no animation and a 1280×800 window, so two runs give the same images.
`scripts/screenshots/views.mjs` lists the views (`editor`, `backlinks`, `settings-locations`, `epub-reader`, `clone`,
`search`) and has its own
step helpers in plain JavaScript; they are not the TypeScript steps of `e2e/steps.ts`, so a renamed
label is fixed in both places. To add a view, add an entry there with the steps a user would take.
An unknown view name is an error (exit 2); a command the demo does not answer fails the run with its
name; a failed view leaves `tmp/shots/failed-<name>-<theme>.png` (git-ignored).
