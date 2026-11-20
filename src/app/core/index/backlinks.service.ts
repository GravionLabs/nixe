import { Injectable, computed, inject, signal } from "@angular/core";

import type { Backlink, IndexedLink, UnlinkedMention } from "../file/backend";
import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { basename } from "../markdown/paths";
import { WorkspaceService } from "../workspace/workspace.service";
import { IndexService } from "./index.service";

export interface OutgoingLink {
  /** Text shown for the link. */
  label: string;
  /** Vault-relative path of the target note; null when unresolved. */
  resolved: string | null;
  heading: string | null;
  line: number;
  kind: IndexedLink["kind"];
}

export type BacklinksState = "idle" | "loading" | "error" | "ready";

/** Links into and out of the open note, read from the vault index. */
@Injectable({ providedIn: "root" })
export class BacklinksService {
  private readonly doc = inject(DocumentService);
  private readonly workspace = inject(WorkspaceService);
  private readonly index = inject(IndexService);

  readonly backlinks = signal<Backlink[]>([]);
  readonly outgoing = signal<OutgoingLink[]>([]);
  /** Plain-text mentions of the open note; filled by `loadUnlinked`, on demand. */
  readonly unlinked = signal<UnlinkedMention[]>([]);
  readonly unlinkedState = signal<"idle" | "loading" | "error" | "ready">("idle");
  private readonly failed = signal(false);
  private request = 0;
  private unlinkedRequest = 0;

  /** Vault-relative path of the open note; null outside a vault. */
  readonly notePath = computed(() => {
    const root = this.workspace.vaultRoot();
    const path = this.doc.path();
    if (!root || !path) return null;
    const prefix = root.endsWith("/") ? root : `${root}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : null;
  });

  /** `loading` while the index is being built, `idle` when there is nothing to show. */
  readonly state = computed<BacklinksState>(() => {
    if (this.notePath() === null) return "idle";
    const status = this.index.status().state;
    if (status === "error" || this.failed()) return "error";
    return status === "ready" ? "ready" : "loading";
  });

  /** Changes whenever the lists must be read again: navigation, index state, index updates. */
  readonly key = computed(
    () => `${this.notePath()}|${this.index.status().state}|${this.index.revision()}`,
  );

  readonly unresolvedCount = computed(() => this.outgoing().filter((l) => !l.resolved).length);

  /** Reads both lists for the open note. A newer call wins over an older one still running. */
  async refresh(): Promise<void> {
    const request = ++this.request;
    const path = this.notePath();
    if (path === null || this.index.status().state !== "ready") {
      this.backlinks.set([]);
      this.outgoing.set([]);
      this.failed.set(false);
      return;
    }
    // allSettled: when both fail, neither rejection may stay unhandled.
    const [backResult, metaResult] = await Promise.allSettled([
      backend.backlinks(path),
      backend.noteMeta(path),
    ]);
    if (request !== this.request) return;
    try {
      if (backResult.status === "rejected") throw backResult.reason;
      if (metaResult.status === "rejected") throw metaResult.reason;
      const back = backResult.value;
      const meta = metaResult.value;
      this.backlinks.set(back);
      this.outgoing.set((meta?.links ?? []).map(toOutgoing));
      this.failed.set(false);
    } catch {
      this.backlinks.set([]);
      this.outgoing.set([]);
      this.failed.set(true);
    }
  }

  /** Reads the unlinked mentions of the open note. A newer call wins over an older one. */
  async loadUnlinked(): Promise<void> {
    const request = ++this.unlinkedRequest;
    const path = this.notePath();
    if (path === null || this.index.status().state !== "ready") {
      this.unlinked.set([]);
      this.unlinkedState.set("idle");
      return;
    }
    this.unlinkedState.set("loading");
    try {
      const found = await backend.unlinkedMentions(path);
      if (request !== this.unlinkedRequest) return;
      this.unlinked.set(found);
      this.unlinkedState.set("ready");
    } catch {
      if (request !== this.unlinkedRequest) return;
      this.unlinked.set([]);
      this.unlinkedState.set("error");
    }
  }

  /** Turns a mention into a `[[link]]` and reads the mentions again. */
  async linkMention(mention: UnlinkedMention): Promise<void> {
    const path = this.notePath();
    if (path === null) return;
    try {
      await backend.linkMention(path, mention);
    } finally {
      await this.loadUnlinked();
    }
  }
}

function toOutgoing(link: IndexedLink): OutgoingLink {
  const name = link.target ? basename(link.target) : "";
  const label = link.target ? name.replace(/\.md$/i, "") : `#${link.heading ?? ""}`;
  return {
    label,
    resolved: link.resolved,
    heading: link.heading,
    line: link.line,
    kind: link.kind,
  };
}
