# ADR 0008: Location variables and own root names for portable workspaces

- Status: Proposed
- Date: 2026-11-23
- Supplements: [workspaces.md](../workspaces.md)
- Issues: #462 (PBI #492)

## Context

A saved workspace (`workspaces/<name>.json`) stores the absolute path of each root. The same
workspace on a second device, or for another user name, points to folders that do not exist: the
home folder, the Documents folder and the cloud folders (OneDrive, iCloud) differ per device. A
root is also named after its folder, so two roots with the same folder name get `notes (2)` and a
renamed folder renames the prefix of every link `[[Wiki:Page]]`.

## Decision

### Location variables

A root path may start with `$Name/…`. The name is resolved on the device that opens the workspace.

- A literal leading `$` is written `$$` (`$$Archive/notes` is the folder `$Archive/notes`).
- Raw environment variables (`%USERPROFILE%`, `$HOME`) are not supported: they differ per
  operating system and shell and make a stored path hard to reason about.
- Built-in variables: `$Home`, `$Documents`, `$OneDrive`, `$iCloud`. A built-in that does not
  exist on a device is unresolved there, like an own variable that is not defined.
- Own variables live per device in the app data only. A workspace stores the variable name, never
  its value, so the file carries no path of one machine and can be shared without leaking one.
- A root whose variable is unresolved is skipped on opening, as a root whose folder is gone is
  today, and Nixe names the variable.

### Saved workspaces stay per device

`workspaces/<name>.json` stays in the app data directory. Syncing or exporting workspaces is a later
feature; this ADR only makes the stored paths portable so that feature can build on it.

### Own root names

The name of a root is stored with the root and is independent of the folder name. It is the prefix
of links between roots (`[[Name:Page]]`) and the label in the sidebar, search results and the
`root:` operator. A root without a stored name uses its folder name, as before. Names stay unique in
a workspace.

## Alternatives

- **Raw environment variables:** differ per system and shell, and `$HOME` is not set on every
  platform.
- **Store the value of own variables in the workspace:** the file would again carry the paths of one
  device.
- **Paths relative to the first root:** breaks when the roots are not siblings.
- **Keep the root name equal to the folder name:** a rename of a folder breaks links, and two
  folders of the same name collide.

## Consequences

- A workspace file holds no device-specific path when its roots start with a variable.
- Every device defines its own variables once; until then the roots that use them are skipped.
- Roots keep stable link prefixes when a folder is renamed or lives elsewhere on another device.
- Following issues implement the variable resolution, the editor for own variables and the stored
  root names; [workspaces.md](../workspaces.md) is updated with them.
