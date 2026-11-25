# ADR 0011: Agent scripts in Nixe

- Status: Proposed
- Date: 2026-11-25
- Issues: #296 (Feature #295)
- Builds on: GravionLabs/poimen [ADR 0019](https://github.com/GravionLabs/poimen/blob/release/next/docs/adr/0019-agent-scripts-format-and-runner.md) (format and runner) and, for runs nobody watches, [ADR 0020](https://github.com/GravionLabs/poimen/blob/release/next/docs/adr/0020-triggered-runs-of-agent-scripts.md); [ADR 0003](0003-nixe-becomes-a-vault-app-with-editing-and-git-sync.md)

## Context

An **agent script** is a saved, named agent call: a Markdown file whose frontmatter says which
harness, model, tools, inputs and output target it uses, and whose body is the prompt. Nixe is to
run such scripts on notes ("summarize this note") and on files that arrive in a watched folder.

poimen ADR 0019 defines the format and the runner (GravionLabs/agent-scripts), shared by poimen,
Nixe and a command line. This ADR does not repeat it; it records only what is particular to Nixe.

A vault is synced content: a script can arrive through a pull from someone else or from an agent,
and a file in an inbox can carry instructions for the agent that reads it. Where scripts live, who
trusts them, what they may do and where they write must be settled before #297, #298 and #299 are
built.

## Decision

### Runner

- Nixe embeds the library of GravionLabs/agent-scripts in the Rust core, as a git dependency pinned
  to a tag (`agent-scripts = { git = "…", tag = "v<x.y.z>" }`), and calls it in-process, off the UI
  thread. No `agent-scripts` binary is shipped, and poimen is not needed.
- The runner starts the installed agent CLI in print mode with the user's login. Nixe has no API
  client and stores no key.
- **Desktop only.** The script commands, the Scripts list and the folder trigger do not exist in
  the iOS build ([ADR 0004](0004-tauri-on-ios-go-git2-for-git-sync-native-swift-only-for-file-access-outside-the-sandbox.md):
  iOS cannot start processes). The scripts stay in the vault as files.
- **No agent CLI installed** (status `failed`): Nixe names the program that was not found and says
  to install it and sign in. Nothing is written.
- **Harness refused** (status `refused`): the Scripts list marks the script as not runnable with
  the runner's reason, Run is disabled, and a run that is started anyway shows the same reason. With
  the built-in definitions of version 1 of the runner this is every `copilot` script, because
  Copilot CLI cannot be kept away from the settings of the repository it runs in. Nixe passes no
  harness definitions of its own; the user config of the runner applies as in GravionLabs/agent-scripts#1.

### Storage

- Scripts are `.agents/scripts/*.md` in the vault root, one level, the same folder poimen and the
  command line use. They are committed with the vault. User scripts of the runner's config
  directory are not listed in Nixe.
- A script is told from a note **by this folder only**: no frontmatter key and no file name makes a
  note elsewhere a script. Nixe shows the scripts in the Scripts list (#298), not in the note tree;
  from there they are opened and edited like a note.
- The folder is fixed. There is **no folder role** for scripts in `.nixe/config.json`
  ([ADR 0007](0007-vault-configuration-in-nixe.md)): a role would let one vault put scripts where
  the other two tools do not look. Nothing about scripts is stored in `.nixe/`.

### Trust

- A script runs only while the SHA-256 of its content equals the hash the user trusted. The trust
  is stored in the **app data directory** (not in the vault, not in `.nixe/local/`), per vault path
  and relative script path, with the granted tools. A synced file therefore cannot trust itself.
- A new or changed script asks once. The dialog shows the frontmatter, the prompt and the tools,
  from the same read whose hash is stored. A changed file has no grants until the user gives them
  again.
- The trusted hash is passed to the runner (the `--expect-sha256` semantics): the runner reads the
  file once, refuses another hash and runs the prompt of that read.
- This holds for scripts the user writes in Nixe too: saving a script changes its hash.

### Tools

- `Read`, `Grep`, `Glob`, `Edit` and `Write` may be listed; trusting the script allows them.
- Every other tool entry, in particular shell, web and MCP tools, needs an **explicit grant per
  script** in the trust dialog, off by default and stored with the hash. The tool of a rule entry is
  the part before its `(`: `Bash(git status)` is a shell tool.
- A script that lists such a tool without a grant is refused with the names of the missing grants.
  Nixe does this check; it does not shorten the list and run the rest.

### Inputs

| Variable | Value in Nixe |
|---|---|
| `{file}` | the open note, relative to `{dir}`; for the folder trigger the file that arrived |
| `{selection}` | the selected text of that note; without a selection a script that uses it does not start |
| `{dir}` | the working directory of the run: the vault root for a manual run, the worktree of the review branch for a triggered run |

Declared inputs of a script are asked for before the start. Scripts run on notes under the vault
root. Nixe saves unsaved edits of the open note before a run, because the agent reads the disk.

### Output

| Target | In Nixe |
|---|---|
| `show` | the result panel |
| `file` | a new note at `path`; an existing file is an error and the text stays in the panel |
| `append` | appended to the note at `path`; `path: "{file}"` appends to the open note |
| `replace` | replaces the selection in the open note; when the selected text changed during the run, the result is shown instead |

- A **manual run writes directly into the vault**: the agent's own edits and the output target. The
  user sees them in the Git changes and takes them back there. An open note that changes on disk is
  handled as every external change ([ADR 0006](0006-terminal-and-agent-panel.md)).
- The target applies only when the run ends `ok`. After a failure, a timeout or Stop no target is
  written; files the agent had already edited with its tools stay changed.

### Folder trigger

A script with `triggers: [{ watch: "<folder or glob>" }]`, relative to the vault root, runs once
for each new file that matches, with that file as `{file}`.

**This goes beyond the poimen ADRs.** poimen ADR 0020 allows no event trigger in its first version,
knows only `{ schedule, timezone }` entries and makes a script with an invalid entry invalid. The
owner decided a folder trigger for Nixe (Feature #295). The shared format therefore has to accept
the `watch` entry as valid (a change of poimen ADR 0019/0020 and of the runner) before #299; Nixe
alone cannot add it. The concerns ADR 0020 names for event triggers are answered below: whoever can
put a file into the folder can start a run, so every such run is untrusted; handled files are
recorded; and the runs are limited. Nixe ignores `schedule` entries (poimen runs those) and says so
in the Scripts list.

- **Only while Nixe is open.** Files that arrived while it was closed are offered as a list at the
  next start; they run only when the user chooses them.
- **Debounce:** a file is taken when it has not changed for 5 seconds. Only a new file starts a
  run, not a change of an existing one. Files a sync pulls in count as new.
- **No loop:** a script never triggers on a file it wrote itself. Nixe records the paths its runs
  wrote, also the ones that reach the vault when their review is accepted. A file that a sync brings
  with the commit that accepted a review of that script (its message names the branch) does not
  trigger it either.
- **One at a time:** per script one triggered run at a time. Further files wait in order and are not
  dropped; a start that the runner refuses because the script is running (also by hand) keeps the
  file waiting and does not count. Files still waiting when Nixe closes are offered at the next
  start.
- **What can have a trigger:** the output target is `file` or `append` with the path of a note, or
  the script writes with its tools (target `show` then only adds the text to the result). A script
  with the target `replace`, with `{selection}` or with a required input without a default does not
  trigger, and the Scripts list says why. A script that only has `show` and no `Edit` or `Write`
  does not trigger either, because its result would reach nobody.
- **Runs per day:** at most **24** triggered runs per script in 24 hours by default; the user may
  set 1 to 96 in the app settings. Every start counts. Files over the limit are listed and nothing
  runs. A script cannot set the limit. One setting switches all folder triggers off.
- **Trust:** the trust dialog of a script with a trigger says that it then runs without a user
  action when files arrive. A hash trusted without that statement does not trigger.

**Untrusted input.** The content of a watched folder was written by others. A triggered run follows
the limits of poimen ADR 0020, which the runner enforces for a run the host marks as triggered:

- The tools are the intersection of the script's list and `Read`, `Grep`, `Glob`, `Edit`, `Write`.
  Grants do not apply: no shell, no web, no MCP, even when granted for manual runs. Dropped tools
  are named in the Scripts list and in the result.
- Reads stay inside `{dir}`, writes stay inside it and out of the paths ADR 0020 denies (`.git`,
  `.agents`, `.claude`, `AGENTS.md`, `CLAUDE.md` and the others). Settings, hooks, plugins and MCP
  servers of the user and the vault are not loaded.
- A run that needs a decision or was denied a tool ends with `error`, and no target is applied.
- A harness or runner version that cannot guarantee these limits refuses the run. Nixe never falls
  back to a manual run.

**Review branch, never the notes** ([#90](https://github.com/GravionLabs/nixe/issues/90),
[ai-review.md](../ai-review.md)):

- `{dir}` of a triggered run is a temporary Git worktree outside the vault, on a new branch from
  `HEAD` named `<review branch prefix>script-<name>-<time>` (default prefix `claude/`).
- Nixe copies the arrived file into it and commits it alone as the **input commit**, then runs the
  script. A second commit holds what the run and its output target changed.
- The review of a script branch compares against the input commit, not the merge base: it shows only
  what the run changed, and the arrived file that still lies uncommitted in the vault merges
  against its own content at the start instead of an empty text. The review of #90 learns this in
  #299.
- The worktree is removed after the run and the branch stays for the review. The user's branch and
  working tree are not written.
- Only notes reach a review. Other files a run created are dropped and named in the result.
- A run that does not end `ok`, or that changed no note, leaves **no branch**. The Scripts list shows
  the last result with its reason, a failure also shows in the status bar, and the file is offered
  again; it does not restart by itself.
- Without a Git repository, or with an empty review branch prefix, folder triggers do not run, and
  the Scripts list says why.

### Relation to what exists

- **ADR 0003** (vault app; it supersedes ADR 0002): scripts are part of the vault app. A run writes
  into the vault, which the read-only viewer of ADR 0002 never did.
- **ADR 0006** (terminal panel): a script run is not a terminal. It has no PTY, nobody can type
  into it, and it does not need the terminal setting to be on. Its consent is the trust per script,
  with fixed tools, instead of the one-time confirmation for a shell. The panel is unchanged.
- **ADR 0007** (`.nixe/`): unchanged; see Storage.
- **#90** (AI changes as review): the folder trigger produces such branches. Manual runs do not,
  by the owner's decision: the user asked for the change and watches it.

## Consequences

- Nixe starts an agent for the first time: after trust on a click, and without one for folder
  triggers.
- A manual run has the limits of its tool list only. The file tools are not limited to the vault,
  so a trusted script, or injected text in a note it reads, can read and write other files of the
  user. This includes the files that carry the consent itself: the trust store in the app data
  directory, the user's agent settings with their hooks (which a manual run loads), the runner's
  user config and `.git/` of the vault. See "Open for the owner".
- A manual change can be committed by auto-sync before the user looked at it; the history of the
  note brings the old text back. A vault without Git has no undo for it.
- A granted MCP tool has no server in version 1 of the runner, which starts `claude` without MCP
  servers (GravionLabs/agent-scripts#1).
- A triggered run sees the committed vault plus the arrived file, not other uncommitted changes,
  also not the results of reviews that are still open.
- The record of written paths belongs to one device. A note that a manual run wrote into a watched
  folder counts as new on another device after a sync.
- Injected content can still put wrong or hostile text into a review branch; the user reviews it.
- One more git dependency; Renovate raises the tag. #297 waits for a first release of the runner.
- Needed from the runner before #299: the `watch` form of `triggers` as a valid entry, and the
  triggered mode of poimen ADR 0020.

## Open for the owner

To decide before this ADR is accepted: **may a manual run write outside the vault?**

- Recommended: no. `Edit` and `Write` of a manual run stay inside `{dir}` and out of the paths
  poimen ADR 0020 denies, without changing which tools need a grant. The runner has to enforce
  this, so #297 would wait for it.
- Otherwise: keep the decision above and accept that the trust and grant rules hold only against a
  script whose file tools are not misused.

## Alternatives

- **Calling the `agent-scripts` binary.** The user would have to install it, or Nixe would ship a
  second program; the library gives the same behavior.
- **A scripts folder under `.nixe/` or a folder role.** poimen and the command line would not find
  the scripts.
- **Trust stored in the vault.** It would travel with the content it is meant to check.
- **A review branch for manual runs too.** Safer, but a summary of one note would need a review.
- **Writing the result of a triggered run into the notes.** Nobody watches the run, and its input
  is written by others.
- **Running scripts in the terminal panel.** Needs the shell opt-in and gives no result record.
