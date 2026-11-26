import type { BaseOrigin } from "../../core/editor/live-preview-core";
import type { BaseBlocks } from "../bases/base-blocks";
import type { BaseHandle } from "./live-preview";

/** The `mountBase` hook of the live preview: the base of `note` inside the widget `el`. */
export function mountLiveBase(
  bases: BaseBlocks,
  el: HTMLElement,
  origin: BaseOrigin,
  occurrence: number,
  note: string | null,
  /** The widget changed its height: the editor has to measure it again. */
  resized: () => void,
): BaseHandle {
  const host = el.appendChild(document.createElement("div"));
  const remove = bases.show(host, origin, occurrence, note);
  // A base grows when its answer arrives.
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resized) : null;
  observer?.observe(el);
  return {
    destroy: () => {
      observer?.disconnect();
      remove();
    },
  };
}
