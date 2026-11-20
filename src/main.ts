import { bootstrapApplication } from "@angular/platform-browser";
import { AppComponent } from "./app/app.component";
import { appConfig } from "./app/app.config";
import { CaptureComponent } from "./app/features/capture/capture.component";

// The capture window (#118) is the same frontend, started with `#capture`.
const root = location.hash === "#capture" ? CaptureComponent : AppComponent;

bootstrapApplication(root, appConfig).catch((err) => console.error(err));
