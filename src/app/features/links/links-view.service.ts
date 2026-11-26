import { Injectable, signal } from "@angular/core";

import type { LinkStatus } from "./link-list";

export type LinksTab = "unread" | "all";
export type LinksLayout = "cards" | "table";

/** What was chosen in the Links view. It outlives the component, which goes when its tab hides. */
@Injectable({ providedIn: "root" })
export class LinksViewService {
  readonly tab = signal<LinksTab>("unread");
  readonly layout = signal<LinksLayout>("cards");
  readonly collection = signal<string | null>(null);
  readonly tag = signal<string | null>(null);
  /** The status filter of the tab "All"; the inbox shows the unread links only. */
  readonly status = signal<LinkStatus | null>(null);
}
