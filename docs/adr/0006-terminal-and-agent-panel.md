# ADR 0006: Terminal and agent panel

- Status: Proposed
- Date: 2026-11-21
- Issues: #291, #358

## Context

Users want to run a shell, and a coding agent such as Claude Code, in the vault without leaving Nixe.
The agent edits notes on disk while Nixe has them open. Nixe needs a terminal in the app, a decision
on how a shell is started on each platform, and a rule for files that change under an open editor.

## Decision

- **PTY:** the Rust core uses the `portable-pty` crate: a real PTY on macOS and Linux and ConPTY on
  Windows. The frontend renders it with xterm.js 6. Poimen uses the same basis; it vendors a ConPTY
  patch, which Nixe takes over only if it turns out to be needed.
- **Shell:** the default shell is detected. macOS and Linux: `SHELL`, else `/bin/sh`. Windows: `pwsh`,
  then `powershell`, then `cmd`. A setting to override the shell comes later.
- **Security:** the terminal runs commands with the rights of the user, so it is off by default. It is
  enabled by an explicit setting that asks for a one-time confirmation.
- **iOS:** not available. iOS has no process spawning, so the setting and the panel are not shown
  there (see [ADR 0004](0004-tauri-on-ios-go-git2-for-git-sync-native-swift-only-for-file-access-outside-the-sandbox.md)).
- **Panel position:** at the bottom, under the editor.
- **A file the agent changes while it is open:** no new policy. The file watcher calls
  `DocumentService.onExternalChange`, which hands the new text to `DocumentService.editorHook`; the
  editor reloads a clean buffer and shows the existing conflict choice for unsaved edits.
- **Out of scope:** the interplay with the AI review branches (#89, #90). It is its own Feature later.

## Alternatives

- **Spawning the shell with pipes (`std::process`):** no PTY, so no prompts, colours, line editing or
  full-screen programs; agents refuse to run.
- **A native terminal embedded through the OS:** differs per platform and does not fit the webview.
- **Own conflict policy for agent edits:** the watcher path already covers external edits, so a second
  one would only disagree with it.
- **On by default:** a vault from a stranger or a stray click would give a shell; opt-in is cheaper
  than a mistake.

## Consequences

- A new Rust dependency (`portable-py` is not needed; `portable-pty`) and xterm.js in the frontend bundle.
- Windows depends on ConPTY behaviour; a patch like Poimen's may follow.
- Until the override setting exists, a user with an unusual shell sets `SHELL` before starting Nixe.
- Agent edits and user edits to the same open note are resolved by the existing conflict choice.
- Review branches for agent changes need their own design.
