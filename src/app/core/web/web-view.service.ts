import { Injectable, signal } from "@angular/core";
import { backend, type WebViewBounds } from "../file/backend";

/** The one page the spike opens. */
export const SPIKE_URL = "https://example.com/";
const SPIKE_ID = "spike";

/**
 * Spike (#567): one child webview over the tab area, driven by development commands of the palette.
 * The web tab kind replaces it when ADR 0010 says go.
 */
@Injectable({ providedIn: "root" })
export class WebViewService {
  private readonly state = signal<"closed" | "shown" | "hidden">("closed");
  readonly status = this.state.asReadonly();

  /** Opens the spike page over `area`; a page that is open already is shown and moved there. */
  async open(area: Element): Promise<void> {
    if (this.state() === "closed") {
      await backend.webViewOpen(SPIKE_ID, SPIKE_URL, boundsOf(area));
      this.state.set("shown");
      return;
    }
    await this.moveTo(area);
    if (this.state() === "hidden") await this.toggle();
  }

  /** Follows the area, for example after a resize of the window. */
  async moveTo(area: Element): Promise<void> {
    if (this.state() === "closed") return;
    await backend.webViewSetBounds(SPIKE_ID, boundsOf(area));
  }

  /** Hides the page, or shows it again. */
  async toggle(): Promise<void> {
    if (this.state() === "closed") return;
    const visible = this.state() === "hidden";
    await backend.webViewSetVisible(SPIKE_ID, visible);
    this.state.set(visible ? "shown" : "hidden");
  }

  async close(): Promise<void> {
    if (this.state() === "closed") return;
    await backend.webViewClose(SPIKE_ID);
    this.state.set("closed");
  }
}

function boundsOf(area: Element): WebViewBounds {
  const { x, y, width, height } = area.getBoundingClientRect();
  return { x, y, width, height };
}
