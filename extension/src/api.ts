/**
 * A thin wrapper over the extension API: Firefox has `browser` (promises), Chromium `chrome`
 * (promises in MV3). Only what the extension uses is typed, so no `@types/chrome` is needed.
 */
import { HOST_NAME, type ClipAnswer, type ClipMessage, type VaultsAnswer } from "./messages.ts";

export interface Tab {
  id?: number;
  url?: string;
  title?: string;
}

interface ExtensionApi {
  runtime: { sendNativeMessage(host: string, message: unknown): Promise<unknown> };
  tabs: { query(query: { active: boolean; currentWindow: boolean }): Promise<Tab[]> };
  scripting: {
    executeScript(injection: {
      target: { tabId: number };
      func: () => string;
    }): Promise<{ result?: unknown }[]>;
  };
  contextMenus: {
    create(props: { id: string; title: string; contexts: string[] }): unknown;
    removeAll(): Promise<void>;
    onClicked: { addListener(cb: (info: { menuItemId: unknown; linkUrl?: string }) => void): void };
  };
  action: {
    setBadgeText(details: { text: string }): Promise<void>;
    setBadgeBackgroundColor(details: { color: string }): Promise<void>;
    setTitle(details: { title: string }): Promise<void>;
  };
}

function api(): ExtensionApi {
  const g = globalThis as unknown as { browser?: ExtensionApi; chrome?: ExtensionApi };
  const found = g.browser ?? g.chrome;
  if (!found) throw new Error("no extension API");
  return found;
}

export function extension(): ExtensionApi {
  return api();
}

export async function clip(message: ClipMessage): Promise<ClipAnswer> {
  return (await api().runtime.sendNativeMessage(HOST_NAME, message)) as ClipAnswer;
}

export async function vaults(): Promise<VaultsAnswer> {
  return (await api().runtime.sendNativeMessage(HOST_NAME, { type: "vaults" })) as VaultsAnswer;
}

/** The rendered HTML of a tab. Needs the `activeTab` grant of a user action. */
export async function renderedHtml(tabId: number): Promise<string | undefined> {
  const [first] = await api().scripting.executeScript({
    target: { tabId },
    func: () => document.documentElement.outerHTML,
  });
  return typeof first?.result === "string" ? first.result : undefined;
}

export async function activeTab(): Promise<Tab | undefined> {
  const [tab] = await api().tabs.query({ active: true, currentWindow: true });
  return tab;
}
