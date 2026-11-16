import { ApplicationConfig, provideBrowserGlobalErrorListeners } from "@angular/core";

import { ACTIVE_TAB_PROVIDERS } from "./core/tabs/tabs.service";

export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), ...ACTIVE_TAB_PROVIDERS],
};
