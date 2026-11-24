import type { ApplicationConfig } from "@angular/core";
import {
  inject,
  isDevMode,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from "@angular/core";

import { HX_UPDATE_BEFORE_INSTALL } from "@gravionlabs/helix-desktop/tauri";
import { provideHxTheme } from "@gravionlabs/helix-ui";

import { AppearanceService } from "./core/appearance/appearance.service";
import { LogService } from "./core/log/log.service";
import { SettingsService } from "./core/settings/settings.service";
import { ACTIVE_TAB_PROVIDERS, TabsService } from "./core/tabs/tabs.service";
import { saveBeforeInstall } from "./core/updater/save-before-install";

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // console.error, console.warn and the uncaught errors that Angular reports go to the log file (#411).
    provideAppInitializer(() => inject(LogService).start()),
    // The settings file is read before the app starts, so the first screen already has them.
    provideAppInitializer(() => inject(SettingsService).load()),
    // Themes and snippets are applied from the first screen on and read again when their files change.
    provideAppInitializer(() => inject(AppearanceService).start()),
    // The theme choice lives in the settings file, so HxTheme remembers nothing itself.
    provideHxTheme({ storageKey: null }),
    // The open note is saved before an update is installed; the app version is provided in `main.ts`.
    { provide: HX_UPDATE_BEFORE_INSTALL, useFactory: saveBeforeInstall },
    // The demo build and `ng serve` (never the release build) offer the e2e tests and the
    // screenshots a way to open a book without a link.
    provideAppInitializer(() => {
      if (!isDevMode()) return;
      const tabs = inject(TabsService);
      (window as unknown as { __nixeDev?: object }).__nixeDev = {
        openEpub: (path: string) => tabs.openEpub(path).then(() => undefined),
      };
    }),
    ...ACTIVE_TAB_PROVIDERS,
  ],
};
