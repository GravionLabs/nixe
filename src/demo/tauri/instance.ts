// The one backend of the page; the stand-ins of the `@tauri-apps/*` modules all talk to it. It is the
// demo, or with `?backend=fake` the scripted variant for interaction tests (#405): it answers only
// what `window.__demoScript` (an init script) or `window.__demo` (at runtime) sets up.
import { createFakeBackend } from "../kit/fake";
import { createNixeDemo } from "../nixe/demo";

const fake = new URLSearchParams(globalThis.location?.search).get("backend") === "fake";

export const demo = fake
  ? { backend: createFakeBackend(globalThis.window?.__demoScript).expose() }
  : createNixeDemo();
