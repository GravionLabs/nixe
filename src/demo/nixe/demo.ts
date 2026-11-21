// The answers of the demo backend (#400): the commands the app calls when it starts, opens a vault,
// shows a note and edits it. A command that is not answered here fails the run with its name
// (`kit/backend.ts`), so a new feature shows up as a red e2e test, not as a silent empty panel.
import { DemoBackend } from "../kit/backend";
import { NOTES, TIME, VAULT } from "./data";
import { DemoVault } from "./vault";

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
    workspace_list: [],
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
    git_vault_status: null,
    git_token_status: false,
    git_provider_available: false,
    git_set_hosts: null,
    git_review_branches: [],
    terminal_preset_check: { available: false },
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
  });
  return { backend, vault };
}
