# Terminal panel

A shell in the vault under the note, rendered with [xterm.js](https://xtermjs.org) 6
(`@xterm/xterm`, `@xterm/addon-fit`; no WebGL addon, the CSP in `tauri.conf.json` stays as it is).
The PTY lives in the Rust core (`terminal_open`, `terminal_write`, `terminal_resize`,
`terminal_close`, see [../backend/tauri-commands.md](../backend/tauri-commands.md)); the decision is
[ADR 0006](../adr/0006-terminal-and-agent-panel.md). Desktop only.

## Parts

| Part | Role |
|---|---|
| `core/terminal/terminal.service.ts` | The command `toggle-terminal` (shortcut `Mod+\``, needs an open vault), the opt-in and its confirmation, the `open` signal, a `notice` for the toast. |
| `core/terminal/terminal-backend.ts` | `invoke` and `listen` wrappers for the four commands and the events `terminal-output-<id>` (base64 bytes) and `terminal-exit-<id>`. A spec replaces it by a fake. |
| `core/terminal/terminal-height.ts` | Pure height rules: default 240, minimum 80, the note keeps 160px, keys and sanitising. |
| `features/terminal/terminal-panel.component.ts` | The panel: xterm, the fit addon, the session, the drag handle (a horizontal separator on the top edge). |

## Settings

Stored in `settings.json` (`SettingsService`), next to `sidebarVisible` and `panelWidth`:

| Key | Default | Meaning |
|---|---|---|
| `terminalEnabled` | `false` | The terminal may be used. The Rust core refuses every command while this is `false`. |
| `terminalConfirmed` | `false` | The user confirmed once. |
| `terminalVisible` | `false` | The panel is shown; survives a restart. |
| `terminalHeight` | `240` | Height of the panel in px; survives a restart. |

The setting "Enable terminal" (section Terminal of the settings page) asks for a confirmation the
first time it is turned on, because a shell runs arbitrary code with the rights of the user. Declining
leaves it off and asks again next time; once confirmed it never asks again. Turning it off hides the
panel and ends the session.

## Behaviour

- **Toggle:** with the terminal on, `toggle-terminal` shows or hides the panel. Hiding keeps the
  component mounted, so the session lives on. With the terminal off the command changes nothing and
  shows a toast that names the setting.
- **Session:** it starts when the panel is first shown, in the vault root, with the size of the
  terminal. Input goes to `terminal_write`; the panel and the window resize the PTY through the fit
  addon. When the shell ends, a key starts a new one. A session belongs to its vault: opening another
  vault ends it, and the next one starts there. Closing the app closes all sessions (Rust).
- **iOS:** there is no process spawning. `TerminalService.supported` is false, so the command is not
  registered, the setting is not listed and the panel is not rendered.
- **Files an agent changes:** no new policy, the file watcher and `DocumentService` handle it (see
  [editor.md](editor.md)).
