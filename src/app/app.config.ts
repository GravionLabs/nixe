import type { ApplicationConfig } from "@angular/core";
import { inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from "@angular/core";

import { provideHxTheme } from "@gravionlabs/helix-ui";

import { AppearanceService } from "./core/appearance/appearance.service";
import { SettingsService } from "./core/settings/settings.service";
import { ACTIVE_TAB_PROVIDERS } from "./core/tabs/tabs.service";

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // The settings file is read before the app starts, so the first screen already has them.
    provideAppInitializer(() => inject(SettingsService).load()),
    // Themes and snippets are applied from the first screen on and read again when their files change.
    provideAppInitializer(() => inject(AppearanceService).start()),
    // The theme choice lives in the settings file, so HxTheme remembers nothing itself.
    provideHxTheme({ storageKey: null }),
    ...ACTIVE_TAB_PROVIDERS,
  ],
};
