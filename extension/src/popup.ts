/** The toolbar popup: title, tags and folder of the current page, then Save. */
import { activeTab, clip, renderedHtml, vaults } from "./api.ts";
import {
  INSTALL_DOCS_URL,
  buildClipMessage,
  describeAnswer,
  describeFailure,
  folderChoices,
  isHostMissing,
  isSavableUrl,
  type Folder,
  type Outcome,
} from "./messages.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function show(outcome: Outcome, withDocsLink = false): void {
  const status = $("status");
  status.className = outcome.kind;
  status.textContent = outcome.text;
  if (withDocsLink) {
    status.append(" ");
    const link = document.createElement("a");
    link.href = INSTALL_DOCS_URL;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Install docs";
    status.append(link);
  }
}

function showFailure(error: unknown): void {
  show(describeFailure(error), isHostMissing(error));
}

async function init(): Promise<void> {
  const tab = await activeTab();
  const form = $<HTMLFormElement>("form");
  if (!tab || tab.id === undefined || !isSavableUrl(tab.url)) {
    form.hidden = true;
    show({ kind: "error", text: "This page cannot be saved: only web pages (http, https)." });
    return;
  }
  const url = tab.url;
  const tabId = tab.id;
  $<HTMLInputElement>("title").value = tab.title ?? "";

  let folders: Folder[] = [];
  try {
    const answer = await vaults();
    if (!answer.ok) throw new Error(answer.error);
    folders = folderChoices(answer.vaults);
  } catch (error) {
    form.hidden = true;
    showFailure(error);
    return;
  }
  const select = $<HTMLSelectElement>("folder");
  folders.forEach((f, i) => select.add(new Option(f.label, String(i))));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void save();
  });

  async function save(): Promise<void> {
    const button = $<HTMLButtonElement>("save");
    button.disabled = true;
    try {
      // Only on this click: the grant of `activeTab` covers the tab, no host permission is held.
      const html = await renderedHtml(tabId).catch(() => undefined);
      const folder = folders[Number(select.value)];
      const answer = await clip(
        buildClipMessage({
          url,
          title: $<HTMLInputElement>("title").value,
          tags: $<HTMLInputElement>("tags").value,
          html,
          folder: folder?.folder,
          vault: folder?.vault,
        }),
      );
      show(describeAnswer(answer));
    } catch (error) {
      showFailure(error);
    } finally {
      button.disabled = false;
    }
  }
}

init().catch((error) => showFailure(error));
