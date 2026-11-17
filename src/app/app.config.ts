import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from "@angular/core";

import { SettingsService } from "./core/settings/settings.service";
import { ACTIVE_TAB_PROVIDERS } from "./core/tabs/tabs.service";

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // The settings file is read before the app starts, so the first screen already has them.
    provideAppInitializer(() => inject(SettingsService).load()),
    ...ACTIVE_TAB_PROVIDERS,
  ],
};
