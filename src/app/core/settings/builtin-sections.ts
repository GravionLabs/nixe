import type { CssFile } from "../appearance/appearance-core";
import {
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  sanitizeAccent,
  sanitizeFont,
  sanitizeTextSize,
} from "../appearance/appearance-core";
import type { ObsidianSetting } from "../file/backend";
import type { Command } from "../commands/command-registry";
import { PAGE_SIZES, sanitizePageSize } from "../export/export-core";
import { clampMinutes } from "../git/auto-sync";
import { sanitizeMode } from "../preview/preview-core";
import type { SettingItem, SettingsSection } from "./settings-registry";
import type { SettingsService } from "./settings.service";
import { ZOOM_MAX, ZOOM_MIN } from "./settings.service";
import type { ThemeMode } from "./settings-core";
import { sanitizePropertiesDisplay } from "./settings-core";

/** What the built-in sections read besides the settings themselves. */
export interface SectionSources {
  settings: SettingsService;
  /** The Obsidian settings of the open vault; null when no vault is open. */
  obsidian: () => readonly ObsidianSetting[] | null;
  commands: () => readonly Command[];
  /** The running app version; empty until known. */
  version: () => string;
  /** The access token of the Git sync; without it the Sync section has no token entry. */
  git?: {
    tokenStored: () => boolean;
    tokenPrompt: () => "required" | "failed" | null;
    saveToken: (token: string) => Promise<void>;
    deleteToken: () => Promise<void>;
    cancelTokenPrompt: () => void;
    gh?: NonNullable<Extract<SettingItem, { kind: "token" }>["gh"]>;
  };
  /** The terminal (#360); absent where there is none (iOS), so the setting is not shown. */
  terminal?: { setEnabled: (value: boolean) => Promise<boolean> };
  /** The theme and snippet files and the folder they live in (#114); none without the appearance service. */
  appearance?: {
    themes: () => readonly CssFile[];
    snippets: () => readonly CssFile[];
    folder: () => string;
  };
}

/** Comma-separated list as typed in a text field. */
export function parseList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** The shown form of an Obsidian setting that the file does not set. */
export const NOT_SET = "Not set";

/** General, Editor, Files and links, Appearance, Sync and Shortcuts. */
export function builtinSections(src: SectionSources): SettingsSection[] {
  const s = src.settings;
  const terminal = src.terminal;
  const toggle = (
    id: string,
    label: string,
    signal: { (): boolean; set(v: boolean): void },
    description?: string,
    keywords?: string[],
  ): SettingItem => ({
    kind: "toggle",
    id,
    label,
    description,
    keywords,
    get: () => signal(),
    set: (v) => signal.set(v),
  });
  const text = (
    id: string,
    label: string,
    signal: { (): string; set(v: string): void },
    description?: string,
    placeholder?: string,
    keywords?: string[],
  ): SettingItem => ({
    kind: "text",
    id,
    label,
    description,
    placeholder,
    keywords,
    get: () => signal(),
    set: (v) => signal.set(v.trim()),
  });

  /** Theme file, accent color, fonts and one switch per snippet (#114). */
  const appearanceItems = (): SettingItem[] => {
    const a = src.appearance;
    if (!a) return [];
    const snippets: SettingItem[] = a.snippets().map((f) => ({
      kind: "toggle" as const,
      id: `snippet-${f.name}`,
      label: f.name,
      description: "CSS snippet; reloads when the file changes.",
      keywords: ["css", "snippet"],
      get: () => s.snippets().includes(f.name),
      set: (on: boolean) =>
        s.snippets.update((l) =>
          on ? [...l.filter((n) => n !== f.name), f.name] : l.filter((n) => n !== f.name),
        ),
    }));
    return [
      {
        kind: "select",
        id: "theme-file",
        label: "Custom theme",
        description: "A CSS file in the themes folder. It changes the look at once.",
        keywords: ["css", "look", "skin"],
        options: [
          { value: "", label: "None" },
          ...a.themes().map((t) => ({ value: t.name, label: t.name })),
        ],
        get: () => s.appearanceTheme(),
        set: (v) => s.appearanceTheme.set(v),
      },
      {
        kind: "text",
        id: "accent-color",
        label: "Accent color",
        description: "A color like #4f46e5. Empty keeps the default.",
        placeholder: "#4f46e5",
        keywords: ["colour", "primary", "highlight"],
        get: () => s.accentColor(),
        set: (v) => s.accentColor.set(sanitizeAccent(v)),
      },
      {
        kind: "text",
        id: "font-text",
        label: "Text font",
        description: "A CSS font-family list. Empty keeps the default.",
        placeholder: "Inter, sans-serif",
        keywords: ["font", "typeface"],
        get: () => s.fontText(),
        set: (v) => s.fontText.set(sanitizeFont(v)),
      },
      {
        kind: "number",
        id: "text-size",
        label: "Text size",
        description: "Size of the note text in px; the zoom multiplies it.",
        keywords: ["font", "size", "scale"],
        min: TEXT_SIZE_MIN,
        max: TEXT_SIZE_MAX,
        get: () => s.textSize(),
        set: (v) => s.textSize.set(sanitizeTextSize(v, s.textSize())),
      },
      {
        kind: "text",
        id: "font-mono",
        label: "Code font",
        description: "A CSS font-family list for code. Empty keeps the default.",
        placeholder: "JetBrains Mono, monospace",
        keywords: ["font", "monospace", "typeface"],
        get: () => s.fontMono(),
        set: (v) => s.fontMono.set(sanitizeFont(v)),
      },
      {
        kind: "readonly",
        id: "appearance-folder",
        label: "Themes and snippets folder",
        description:
          "Put theme files into `themes/` and snippets into `snippets/` of this folder. Obsidian themes and snippets are not loaded.",
        keywords: ["css", "folder", "directory", "obsidian"],
        value: () => a.folder() || "Unknown",
      },
      ...snippets,
    ];
  };

  return [
    {
      id: "general",
      title: "General",
      order: 10,
      items: () => [
        {
          kind: "readonly" as const,
          id: "version",
          label: "Version",
          description: "The running version of Nixe.",
          keywords: ["about", "release", "build"],
          value: () => src.version() || "Unknown",
        },
        toggle("sidebar", "Show the sidebar", s.sidebarVisible, "The file tree of the vault.", [
          "files",
          "tree",
        ]),
        toggle(
          "tree-git-status",
          "Git status in the file tree",
          s.treeGitStatus,
          "Mark changed, added and untracked notes with a letter and a color, and their folders with a dot.",
          ["git", "decoration", "files", "modified"],
        ),
        toggle(
          "backlinks",
          "Show the backlinks panel",
          s.backlinksVisible,
          "Notes that link to the open note.",
          ["links"],
        ),
        toggle(
          "outline",
          "Show the outline panel",
          s.outlineVisible,
          "The headings of the open note.",
          ["headings", "toc"],
        ),
      ],
    },
    ...(terminal
      ? [
          {
            id: "terminal",
            title: "Terminal",
            order: 55,
            items: (): SettingItem[] => [
              {
                kind: "toggle",
                id: "terminal-enabled",
                label: "Enable terminal",
                description:
                  "A shell in the vault under the note (command “Toggle terminal”). It runs commands with your rights, so it is off until you confirm.",
                keywords: ["shell", "console", "command line", "pty", "agent", "claude"],
                get: () => s.terminalEnabled(),
                set: (v: boolean) => void terminal.setEnabled(v),
              },
            ],
          },
        ]
      : []),
    {
      id: "editor",
      title: "Editor",
      order: 20,
      items: () => [
        toggle("math", "LaTeX math", s.math, "Render $…$ and $$…$$ with KaTeX.", [
          "formula",
          "katex",
        ]),
        toggle(
          "wrap-code",
          "Wrap lines in code blocks",
          s.wrapCode,
          "Wrap long lines instead of scrolling sideways.",
          ["code", "scroll", "horizontal"],
        ),
      ],
    },
    {
      id: "export",
      title: "Export and print",
      order: 25,
      items: () => [
        toggle(
          "export-page-breaks",
          "Page break before top-level headings",
          s.exportPageBreaks,
          "Each `# Heading` starts a new page in a PDF or a print.",
          ["pdf", "print", "page"],
        ),
        toggle(
          "export-dark",
          "Dark look",
          s.exportDark,
          "Export and print with the dark colors instead of the light ones.",
          ["pdf", "print", "html", "theme"],
        ),
        {
          kind: "select",
          id: "export-page-size",
          label: "Page size",
          keywords: ["pdf", "print", "paper", "a4", "letter"],
          options: PAGE_SIZES.map((v) => ({ value: v, label: v })),
          get: () => s.exportPageSize(),
          set: (v) => s.exportPageSize.set(sanitizePageSize(v)),
        },
      ],
    },
    {
      id: "files",
      title: "Files and links",
      order: 30,
      items: () => {
        const obsidian = src.obsidian();
        const fromVault: SettingItem[] = obsidian
          ? obsidian.map((o) => ({
              kind: "readonly" as const,
              id: `obsidian-${o.id}`,
              label: o.label,
              description: "Set in Obsidian; change it there.",
              keywords: ["obsidian", o.source],
              value: () => o.value ?? NOT_SET,
              source: () => o.source,
            }))
          : [
              {
                kind: "readonly" as const,
                id: "obsidian-none",
                label: "Obsidian settings",
                description:
                  "Open a vault to see its new-note folder, attachment folder, link format, templates and daily notes.",
                keywords: ["obsidian", "attachment", "link format", "new note", "daily"],
                value: () => "No vault open",
              },
            ];
        return [
          ...fromVault,
          text(
            "template-folder",
            "Template folder",
            s.templateFolder,
            "Used when `.obsidian/templates.json` names none.",
            "Templates",
          ),
          text(
            "daily-folder",
            "Daily notes folder",
            s.dailyFolder,
            "Used when `.obsidian/daily-notes.json` sets none.",
          ),
          text(
            "daily-format",
            "Daily notes date format",
            s.dailyFormat,
            "Used when `.obsidian/daily-notes.json` sets none.",
            "YYYY-MM-DD",
          ),
          text(
            "daily-template",
            "Daily notes template",
            s.dailyTemplate,
            "Used when `.obsidian/daily-notes.json` sets none.",
          ),
          {
            kind: "text",
            id: "health-exclude",
            label: "Leave out of the vault health report",
            description: "Folders, separated by commas.",
            placeholder: "Templates, Archive",
            keywords: ["health", "exclude"],
            get: () => s.healthExclude().join(", "),
            set: (v) => s.healthExclude.set(parseList(v)),
          },
          toggle(
            "bookmarks-in-vault",
            "Write bookmarks into the vault",
            s.bookmarksInVault,
            "Keep them in `.obsidian/bookmarks.json` (shared with Obsidian) instead of the app data. Needs a vault with an `.obsidian` folder.",
            ["bookmarks", "obsidian"],
          ),
          toggle(
            "extract-embed",
            "Leave an embed when extracting",
            s.extractEmbed,
            "Extract selection and Extract heading leave `![[note]]` instead of `[[note]]`.",
            ["extract", "composer", "embed"],
          ),
        ];
      },
    },
    {
      id: "capture",
      title: "Capture",
      order: 35,
      items: () => [
        text(
          "capture-shortcut",
          "Global shortcut",
          s.captureShortcut,
          "Opens the capture window from anywhere on the desktop, also without a Nixe window. Leave empty to turn capture off. With a shortcut set, Nixe keeps running in the tray when its window closes; quit it there.",
          "CommandOrControl+Shift+Space",
        ),
        {
          kind: "select",
          id: "capture-target",
          label: "Save captures to",
          options: [
            { value: "daily", label: "Today's daily note" },
            { value: "inbox", label: "A new note in the inbox folder" },
          ],
          get: () => s.captureTarget(),
          set: (v) => s.captureTarget.set(v === "inbox" ? "inbox" : "daily"),
        },
        text(
          "capture-inbox",
          "Inbox folder",
          s.captureInbox,
          "Vault-relative. Empty uses the new-note folder of the vault, else `Inbox`.",
          "Inbox",
        ),
        text(
          "capture-template",
          "Inbox note template",
          s.captureTemplate,
          "A note of the vault; `{{content}}` marks where the text goes, `{{title}}`, `{{date}}` and `{{time}}` work too. The daily note keeps its own template.",
          "Templates/Capture",
        ),
      ],
    },
    {
      id: "appearance",
      title: "Appearance",
      order: 40,
      items: () => [
        {
          kind: "select",
          id: "theme",
          label: "Color mode",
          keywords: ["dark", "light", "color"],
          options: [
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ],
          get: () => s.themeMode(),
          set: (v) => s.themeMode.set(v as ThemeMode),
        },
        {
          kind: "number",
          id: "zoom",
          label: "Zoom",
          description: "In percent; 100 is the actual size.",
          keywords: ["size", "scale"],
          min: ZOOM_MIN,
          max: ZOOM_MAX,
          get: () => s.zoom(),
          set: (v) => s.zoom.set(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v)))),
        },
        {
          kind: "select",
          id: "link-preview",
          label: "Link preview",
          description: "Preview a note when hovering a link to it.",
          keywords: ["hover", "popover"],
          options: [
            { value: "modifier", label: "Only with ⌘/Ctrl held" },
            { value: "always", label: "Always" },
          ],
          get: () => s.linkPreview(),
          set: (v) => s.linkPreview.set(sanitizeMode(v)),
        },
        {
          kind: "select",
          id: "properties-display",
          label: "Properties in document",
          description: "How the properties of a note show above its text.",
          keywords: ["frontmatter", "fold", "hide", "yaml"],
          options: [
            { value: "visible", label: "Visible" },
            { value: "folded", label: "Folded" },
            { value: "hidden", label: "Hidden" },
          ],
          get: () => s.propertiesDisplay(),
          set: (v) => s.propertiesDisplay.set(sanitizePropertiesDisplay(v)),
        },
        ...appearanceItems(),
      ],
    },
    {
      id: "sync",
      title: "Sync",
      order: 50,
      items: () => [
        ...(src.git
          ? [
              {
                kind: "token" as const,
                id: "git-token",
                label: "Access token",
                description:
                  "A personal access token to reach GitHub. It is kept in the system keychain.",
                keywords: ["git", "github", "password", "key", "keychain", "login", "sync"],
                stored: src.git.tokenStored,
                prompt: src.git.tokenPrompt,
                save: src.git.saveToken,
                remove: src.git.deleteToken,
                cancelPrompt: src.git.cancelTokenPrompt,
                gh: src.git.gh,
              },
            ]
          : []),
        text(
          "git-enterprise-host",
          "GitHub Enterprise host",
          s.gitEnterpriseHost,
          "Host of a GitHub Enterprise Server that may receive the token, for example ghe.example.com. Leave empty for github.com only.",
          "ghe.example.com",
          ["git", "github", "enterprise", "ghe", "host", "server", "sync"],
        ),
        text(
          "git-author-name",
          "Commit author name",
          s.gitAuthorName,
          "Used when the Git config of the vault has none.",
          undefined,
          ["git", "author", "name", "sync"],
        ),
        text(
          "git-author-email",
          "Commit author email",
          s.gitAuthorEmail,
          "Used when the Git config of the vault has none.",
          undefined,
          ["git", "author", "email", "sync"],
        ),
        toggle(
          "auto-sync",
          "Sync automatically",
          s.autoSync,
          "Commit and sync the vault on a timer.",
          ["git", "pull", "push"],
        ),
        {
          kind: "number",
          id: "auto-sync-minutes",
          label: "Sync every (minutes)",
          keywords: ["interval", "timer", "git", "sync"],
          min: 1,
          max: 1440,
          get: () => s.autoSyncMinutes(),
          set: (v) => s.autoSyncMinutes.set(clampMinutes(v)),
        },
        toggle("auto-sync-focus", "Sync when the window gets focus", s.autoSyncOnFocus, undefined, [
          "git",
        ]),
        toggle("auto-sync-quit", "Sync when quitting", s.autoSyncOnQuit, undefined, ["git"]),
        text(
          "review-branch-prefix",
          "Review branch prefix",
          s.reviewBranchPrefix,
          "Branches with this prefix that are ahead of the working branch wait for review. Empty turns the review off.",
          "claude/",
        ),
      ],
    },
    {
      id: "shortcuts",
      title: "Shortcuts",
      order: 60,
      items: () =>
        src
          .commands()
          .slice()
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((c) => ({
            kind: "shortcut" as const,
            id: `shortcut-${c.id}`,
            commandId: c.id,
            label: c.title,
            keywords: ["keyboard", "key", "binding", c.id],
          })),
    },
  ];
}
