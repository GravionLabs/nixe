import { inject } from "@angular/core";
import type { HxUpdateBeforeInstall } from "@gravionlabs/helix-desktop/tauri";

import { EditorService } from "../editor/editor.service";

/**
 * The hook before an update is installed: saves the open note. Windows quits the app when the installer
 * starts, so the text must be on disk first. Throwing refuses the install; the update stays available.
 */
export function saveBeforeInstall(): HxUpdateBeforeInstall {
  const editor = inject(EditorService);
  return async () => {
    await editor.handle?.flush();
    // `flush` swallows a failed write and writes nothing while a conflict is open.
    if (editor.handle?.dirty()) throw new Error("the open note could not be saved");
  };
}
