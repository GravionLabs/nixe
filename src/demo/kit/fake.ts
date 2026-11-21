// The scripted variant of the demo backend (#405) for interaction tests: it answers only what a
// test sets up, fails on every other command by name (`window.__demoFailures`) and records every call
// (`window.__demoCalls`), both through `DemoBackend`. It imports nothing from the app.
import { DemoBackend, type Answer, type DemoCall } from "./backend";

/** What a test sets up for a command: a function answers from the arguments, any other value is the answer. */
export type Scripted = unknown;

/** The handle a runner reaches as `window.__demo` (`page.evaluate`). */
export interface DemoHandle {
  /** Sets or replaces the answer of a command. */
  answer(command: string, value: Scripted): void;
  /** Pushes an event to the listeners of the app. */
  emit(event: string, payload?: unknown): void;
  /** The recorded calls, of one command when given. */
  calls(command?: string): DemoCall[];
}

declare global {
  interface Window {
    __demo?: DemoHandle;
    /** The answers an init script gives to the fake backend before the app starts (JSON values). */
    __demoScript?: Record<string, unknown>;
  }
}

const asAnswer = (value: Scripted): Answer =>
  typeof value === "function"
    ? (value as Answer)
    : () => (value === undefined ? value : structuredClone(value));

export class FakeBackend extends DemoBackend {
  /** Sets or replaces the answer of a command. */
  script(command: string, value: Scripted): this {
    return this.answer({ [command]: asAnswer(value) });
  }

  /** The calls made so far, of one command when given. */
  callsOf(command?: string): DemoCall[] {
    const calls = globalThis.window?.__demoCalls ?? [];
    return command === undefined ? [...calls] : calls.filter((c) => c.command === command);
  }

  /** Exposes this backend to the runner as `window.__demo`. */
  expose(): this {
    globalThis.window.__demo = {
      answer: (command, value) => void this.script(command, value),
      emit: (event, payload) => this.emit(event, payload),
      calls: (command) => this.callsOf(command),
    };
    return this;
  }
}

/** A backend that answers only `answers` (functions or fixed values by command). */
export function createFakeBackend(answers: Record<string, Scripted> = {}): FakeBackend {
  const backend = new FakeBackend();
  for (const [command, value] of Object.entries(answers)) backend.script(command, value);
  return backend;
}
