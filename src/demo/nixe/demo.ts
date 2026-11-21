// The answers of the demo backend (#400, #403): the commands the app calls when it starts, opens a
// vault, shows a note and edits it, and those of the Git views, the workspaces and the terminal. A command that is not answered here fails the run with its name
// (`kit/backend.ts`), so a new feature shows up as a red e2e test, not as a silent empty panel.
import { DemoBackend } from "../kit/backend";
import type { Workspace } from "../../app/core/file/backend";
import { NOTES, TIME, VAULT } from "./data";
import { DemoGit } from "./git";
import { DemoVault } from "./vault";

const num = (args: Record<string, unknown> | undefined, key: string): number => {
  const value = args?.[key];
  return typeof value === "number" ? value : 0;
};

const strOrNull = (args: Record<string, unknown> | undefined, key: string): string | null => {
  const value = args?.[key];
  return typeof value === "string" ? value : null;
};

const strings = (args: Record<string, unknown> | undefined, key: string): string[] => {
  const value = args?.[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
};

/** What the shell of the demo terminal prints; the bytes travel as base64 like the Rust core's. */
const PROMPT = "demo@nixe:~/Notes$ ";
const toBase64 = (text: string): string => {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const str = (args: Record<string, unknown> | undefined, key: string): string => {
  const value = args?.[key];
  return typeof value === "string" ? value : "";
};

export interface NixeDemo {
  backend: DemoBackend;
  vault: DemoVault;
}

export function createNixeDemo(): NixeDemo {
  const backend = new DemoBackend();
  const vault = new DemoVault(VAULT, NOTES, Date.parse(TIME));
  const git = new DemoGit(vault, Date.parse(TIME));
  const workspaces = new Map<string, Workspace>();
  const tokens = new Set<string>();
  const sessions = new Map<number, string>();
  let nextSession = 1;
  // Starts the app in the demo vault; the writes of the app stay in memory.
  let settings: string | null = JSON.stringify({ lastFolder: VAULT, recentVaults: [VAULT] });
  let bookmarks: string | null = null;
  let folds: string | null = null;

  backend.fixed({
    take_pending_file: null,
    take_pending_export: null,
    finish_export: null,
    read_appearance: [],
    appearance_dir: "/demo/config",
    read_vault_bookmarks: null,
    write_vault_bookmarks: null,
    set_menu_shortcuts: 0,
    find_vault_root: VAULT,
    find_wiki_root: VAULT,
    obsidian_settings: [],
    link_format: "shortest",
    new_note_location: { location: "root", folder: "" },
    template_folder: null,
    daily_notes_config: { folder: "Daily", format: "YYYY-MM-DD", template: null },
    last_vault_operation: null,
    is_utf8_file: true,
    watch_file: null,
    read_data_uri: null,
    read_bundled_data_uri: null,
    index_start: null,
    related_notes: [],
    unlinked_mentions: [],
    git_provider_available: false,
  });

  backend.answer({
    read_app_settings: () => settings,
    write_app_settings: (a) => void (settings = str(a, "content")),
    read_app_bookmarks: () => bookmarks,
    write_app_bookmarks: (a) => void (bookmarks = str(a, "content")),
    read_folds: () => folds,
    write_folds: (a) => void (folds = str(a, "content")),
    is_dir: (a) => vault.isDir(str(a, "path")),
    is_file: (a) => vault.isFile(str(a, "path")),
    path_exists: (a) => vault.exists(str(a, "path")),
    list_dir: (a) => vault.listDir(str(a, "path")),
    list_vault_files: () => vault.relativeFiles(),
    read_text_file: (a) => vault.read(str(a, "path")),
    write_text_file: (a) => vault.write(str(a, "path"), str(a, "content")),
    create_file: (a) => {
      if (vault.exists(str(a, "path"))) throw "already exists";
      vault.write(str(a, "path"), "");
    },
    create_dir: (a) => vault.makeDir(str(a, "path")),
    index_status: () => {
      const notes = vault.notes().length;
      return { state: "ready", done: notes, total: notes, notes, error: null };
    },
    notes: () => vault.notes(),
    note_meta: (a) => vault.meta(str(a, "path")),
    backlinks: (a) => vault.backlinks(str(a, "path")),
    tags: () => vault.tags(),
    search_notes: (a) => vault.search(str(a, "query")),
    capture_note_names: () => vault.notes().map((n) => n.title),
    // The spike editor lists the notes by name when the app starts (`editor-spike.component.ts`).
    notes_list: () => vault.notes().map((n) => n.title),
    capture_save: (a) => {
      const path = `${VAULT}/Inbox.md`;
      const before = vault.isFile(path) ? vault.read(path) : "# Inbox\n";
      vault.write(path, `${before}\n${str(a, "text")}\n`);
      return path;
    },
    capture_hide: () => null,
    capture_apply: () => null,
    capture_link_title: () => null,
    vault_health: () => ({ brokenLinks: [], orphans: [], duplicates: [], unusedAttachments: [] }),

    // Git: a seeded history (`git.ts`), the open changes and a branch to review.
    git_vault_status: () => git.status(),
    git_vault_log: (a) => git.log(num(a, "offset"), num(a, "limit")),
    git_note_history: (a) => git.noteHistory(str(a, "path"), num(a, "offset"), num(a, "limit")),
    git_note_version: (a) => git.noteVersion(str(a, "path"), strOrNull(a, "rev")),
    git_changes_between: (a) => git.changesBetween(str(a, "from"), strOrNull(a, "to")),
    git_rev_at: (a) => git.revAt(num(a, "time")),
    git_deleted_notes: (a) => git.deletedNotes(num(a, "commits")),
    git_recent_notes: (a) => git.recentNotes(num(a, "commits"), num(a, "limit")),
    git_review_branches: (a) => git.reviewBranches(str(a, "prefix")),
    git_review_changes: (a) => git.reviewChanges(str(a, "rev")),
    git_review_hunks: (a) => git.reviewHunks(str(a, "tip"), str(a, "path")),
    git_review_finish: (a) =>
      git.reviewFinish(
        str(a, "branch"),
        (a?.["decisions"] ?? []) as Parameters<DemoGit["reviewFinish"]>[1],
        a?.["deleteBranch"] === true,
      ),
    git_review_state_load: (a) => git.reviewStateLoad(str(a, "branch")),
    git_review_state_save: (a) => git.reviewStateSave(str(a, "branch"), strOrNull(a, "content")),
    git_vault_commit: (a) =>
      git.commit(strOrNull(a, "message"), a?.["paths"] ? strings(a, "paths") : null),
    git_vault_sync: () => git.sync(),
    conflict_pair: () => git.conflictPair(),
    resolve_conflict: (a) => str(a, "path"),
    git_token_status: (a) => tokens.has(str(a, "host")),
    git_token_set: (a) => void tokens.add(str(a, "host")),
    git_token_delete: (a) => void tokens.delete(str(a, "host")),
    git_set_hosts: () => null,

    // Workspaces: kept in memory; every root resolves to the demo vault.
    workspace_list: () => [...workspaces.keys()].sort(),
    workspace_load: (a) => {
      const workspace = workspaces.get(str(a, "name"));
      if (!workspace) throw `No such workspace: ${str(a, "name")}`;
      return workspace;
    },
    workspace_save: (a) => {
      const workspace = a?.["workspace"] as Workspace;
      workspaces.set(workspace.name, structuredClone(workspace));
    },
    workspace_delete: (a) => void workspaces.delete(str(a, "name")),
    workspace_add_root: (a) => {
      const workspace = structuredClone(a?.["workspace"] as Workspace);
      const path = str(a, "path");
      workspace.roots.push({ path, name: path.slice(path.lastIndexOf("/") + 1), kind: "folder" });
      return workspace;
    },
    workspace_resolve_links: (a) =>
      strings(a, "targets").map((target) => {
        const path = vault.resolve(target);
        return path ? { root: VAULT, path } : null;
      }),
    workspace_index: () => null,
    workspace_notes: () =>
      vault.notes().map((note) => ({ ...note, root: "Notes", rootPath: VAULT })),
    search_workspace: (a) =>
      vault.search(str(a, "query")).map((hit) => ({ ...hit, root: "Notes", rootPath: VAULT })),

    // Terminal: a session that echoes what is typed and answers a command with a fixed line.
    terminal_open: () => {
      const id = nextSession++;
      sessions.set(id, "");
      return id;
    },
    terminal_preset_check: () => null,
    terminal_attach: (a) => {
      const id = num(a, "id");
      queueMicrotask(() => backend.emit(`terminal-output-${id}`, { data: toBase64(PROMPT) }));
    },
    terminal_write: (a) => {
      const id = num(a, "id");
      const typed = str(a, "data");
      let line = sessions.get(id) ?? "";
      let out = "";
      for (const ch of typed) {
        if (ch === "\r") {
          out += `\r\nThis is the terminal of the demo: it runs no commands.\r\n${PROMPT}`;
          line = "";
        } else if (ch === "\x7f") {
          if (line) out += "\b \b";
          line = line.slice(0, -1);
        } else {
          out += ch;
          line += ch;
        }
      }
      sessions.set(id, line);
      backend.emit(`terminal-output-${id}`, { data: toBase64(out) });
    },
    terminal_resize: () => null,
    terminal_close: (a) => {
      const id = num(a, "id");
      sessions.delete(id);
      backend.emit(`terminal-exit-${id}`, null);
    },
  });
  return { backend, vault };
}
