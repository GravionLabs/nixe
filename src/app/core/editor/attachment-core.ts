import { basename } from "../markdown/paths";

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

const pad = (n: number): string => String(n).padStart(2, "0");

/** `Pasted image 20260316142530.png`; the number is the local time `YYYYMMDDHHmmss`. */
export function pastedImageName(date: Date, mime = "image/png"): string {
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `Pasted image ${stamp}.${IMAGE_EXTENSIONS[mime] ?? "png"}`;
}

/**
 * `![[name]]` for a vault-relative path; the full path when another file of the vault has the same
 * name, so the link stays unambiguous.
 */
export function embedFor(relativePath: string, vaultFiles: readonly string[]): string {
  const name = basename(relativePath);
  const clash = vaultFiles.some((f) => f !== relativePath && basename(f) === name);
  return `![[${clash ? relativePath : name}]]`;
}
