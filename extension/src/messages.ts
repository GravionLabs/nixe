/**
 * The messages between the extension and the Native Messaging host (`nixe native-host`, see
 * docs/links.md) and the texts the extension shows for the answers. Pure, so it runs in Vitest.
 */

export const HOST_NAME = "app.gravionlabs.nixe";

/** Where the install of the native host is described. */
export const INSTALL_DOCS_URL =
  "https://github.com/GravionLabs/nixe/blob/main/docs/links.md#browser-extension-host";

export interface ClipMessage {
  type: "clip";
  url: string;
  title?: string;
  html?: string;
  tags?: string[];
  folder?: string;
  vault?: string;
}

export interface VaultInfo {
  name: string;
  path: string;
  folder: string;
  folders: string[];
}

export type ClipAnswer =
  | { ok: true; path: string; created: boolean; vault: string }
  | { ok: false; error: string };

export type VaultsAnswer = { ok: true; vaults: VaultInfo[] } | { ok: false; error: string };

export const vaultsMessage = { type: "vaults" } as const;

export interface PageInput {
  url: string;
  title?: string;
  html?: string;
  /** The tags as typed: separated by commas. */
  tags?: string;
  folder?: string;
  vault?: string;
}

/** Tags from a comma separated field: trimmed, without a leading `#`, no empty or double ones. */
export function parseTags(raw: string | undefined): string[] {
  const seen = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const tag = part.trim().replace(/^#+/, "").trim();
    if (tag) seen.add(tag);
  }
  return [...seen];
}

/** The `clip` message of a page; empty fields are left out. */
export function buildClipMessage(page: PageInput): ClipMessage {
  const message: ClipMessage = { type: "clip", url: page.url };
  const title = page.title?.trim();
  if (title) message.title = title;
  if (page.html) message.html = page.html;
  const tags = parseTags(page.tags);
  if (tags.length > 0) message.tags = tags;
  if (page.folder) message.folder = page.folder;
  if (page.vault) message.vault = page.vault;
  return message;
}

/** The `clip` message of a link of the context menu: the URL alone, no HTML. */
export function buildLinkMessage(url: string): ClipMessage {
  return buildClipMessage({ url });
}

/** The name of a note: its file name without the folder and the `.md`. */
export function noteName(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.md$/i, "");
}

export interface Folder {
  vault: string;
  /** The vault-relative folder, as the host wants it in `folder`. */
  folder: string;
  label: string;
}

/** The folders to choose from: the links folder of each vault and its sub folders. */
export function folderChoices(vaults: VaultInfo[]): Folder[] {
  const many = vaults.length > 1;
  return vaults.flatMap((v) =>
    [v.folder, ...v.folders].map((folder) => ({
      vault: v.name,
      folder,
      label: many ? `${v.name}: ${folder}` : folder,
    })),
  );
}

export type Outcome =
  | { kind: "saved"; text: string }
  | { kind: "already"; text: string }
  | { kind: "error"; text: string };

/** What to tell the person about the answer of the host. */
export function describeAnswer(answer: ClipAnswer): Outcome {
  if (!answer.ok) return { kind: "error", text: answer.error };
  const name = noteName(answer.path);
  return answer.created
    ? { kind: "saved", text: `Saved: ${name}` }
    : { kind: "already", text: `Already saved: ${name}` };
}

/** True when the browser says that it cannot reach the host (not installed, not allowed). */
export function isHostMissing(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  // Chromium: "Specified native messaging host not found." / "Access to the specified native
  // messaging host is forbidden."; Firefox: "No such native application app.gravionlabs.nixe".
  return /native messaging host (not found|is forbidden)|no such native application|not found/i.test(
    text,
  );
}

export const hostMissingText =
  "Nixe is not set up for the browser: the native host was not found. Install it from Nixe (Help > Install browser extension support…).";

/** The text for an error of the call to the host. */
export function describeFailure(error: unknown): Outcome {
  if (isHostMissing(error)) return { kind: "error", text: hostMissingText };
  const text = error instanceof Error ? error.message : String(error);
  return { kind: "error", text: `Could not reach Nixe: ${text}` };
}

/** True for a URL the extension can save: a web page. */
export function isSavableUrl(url: string | undefined): url is string {
  return url !== undefined && /^https?:\/\//i.test(url);
}
