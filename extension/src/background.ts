/**
 * The background script of the extension: a service worker in Chromium, an event page in Firefox.
 * It owns the context menu "Save link to Nixe" on a link: the URL is saved without HTML. The
 * result shows on the toolbar button (a badge), as the background has no window of its own.
 */
import { clip, extension } from "./api.ts";
import { buildLinkMessage, describeAnswer, describeFailure, type Outcome } from "./messages.ts";

export const MENU_ID = "save-link-to-nixe";

async function badge(outcome: Outcome): Promise<void> {
  const { action } = extension();
  const ok = outcome.kind !== "error";
  await action.setBadgeBackgroundColor({ color: ok ? "#2e7d32" : "#c62828" });
  await action.setBadgeText({ text: ok ? "✓" : "!" });
  await action.setTitle({ title: `Nixe: ${outcome.text}` });
  setTimeout(() => void action.setBadgeText({ text: "" }), 5000);
}

export async function saveLink(url: string): Promise<Outcome> {
  try {
    return describeAnswer(await clip(buildLinkMessage(url)));
  } catch (error) {
    return describeFailure(error);
  }
}

function register(): void {
  const { contextMenus } = extension();
  contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === MENU_ID && info.linkUrl) {
      void saveLink(info.linkUrl).then(badge);
    }
  });
  void contextMenus.removeAll().then(() => {
    contextMenus.create({ id: MENU_ID, title: "Save link to Nixe", contexts: ["link"] });
  });
}

register();
