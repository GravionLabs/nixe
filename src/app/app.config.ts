import type { ApplicationConfig } from "@angular/core";
import { inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from "@angular/core";

import { HX_UPDATE_BEFORE_INSTALL } from "@gravionlabs/helix-desktop/tauri";
import { provideHxTheme } from "@gravionlabs/helix-ui";

import { AppearanceService } from "./core/appearance/appearance.service";
import { SettingsService } from "./core/settings/settings.service";
import { ACTIVE_TAB_PROVIDERS } from "./core/tabs/tabs.service";
import { saveBeforeInstall } from "./core/updater/save-before-install";

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // The settings file is read before the app starts, so the first screen already has them.
    provideAppInitializer(() => inject(SettingsService).load()),
    // Themes and snippets are applied from the first screen on and read again when their files change.
    provideAppInitializer(() => inject(AppearanceService).start()),
    // The theme choice lives in the settings file, so HxTheme remembers nothing itself.
    provideHxTheme({ storageKey: null }),
    // The open note is saved before an update is installed; the app version is provided in `main.ts`.
    { provide: HX_UPDATE_BEFORE_INSTALL, useFactory: saveBeforeInstall },
    ...ACTIVE_TAB_PROVIDERS,
  ],
};
