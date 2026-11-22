import { mergeApplicationConfig } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import { provideHxAppInfo, readTauriVersion } from "@gravionlabs/helix-desktop/tauri";
import { AppComponent } from "./app/app.component";
import { appConfig } from "./app/app.config";
import { CaptureComponent } from "./app/features/capture/capture.component";

// The capture window (#118) is the same frontend, started with `#capture`.
const root = location.hash === "#capture" ? CaptureComponent : AppComponent;

// The version comes from Tauri; the channel (`rc`) follows from it.
readTauriVersion("")
  .then((version) =>
    bootstrapApplication(
      root,
      mergeApplicationConfig(appConfig, { providers: [provideHxAppInfo({ version })] }),
    ),
  )
  .catch((err) => console.error(err));
