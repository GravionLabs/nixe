// The harness of the e2e specs (#403): the real typed wrappers of the app (`backend`, `TerminalBackend`)
// run against the demo backend, through the stand-in of `mock.ts`.
import { backend } from "../../app/core/file/backend";
import { TerminalBackend } from "../../app/core/terminal/terminal-backend";
import { useDemo } from "./mock";

/** A fresh demo and the wrappers of the app that talk to it. */
export function loadApp() {
  delete window.__demoCalls;
  delete window.__demoFailures;
  const demo = useDemo();
  return { backend, terminal: new TerminalBackend(), demo };
}
