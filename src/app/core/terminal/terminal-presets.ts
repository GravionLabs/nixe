/** An agent CLI that opens in its own tab in the vault root; `id` names the preset in the Rust core (`terminal.rs`). */
export interface TerminalPreset {
  readonly id: string;
  readonly title: string;
  readonly commandId: string;
  readonly commandTitle: string;
}

/** The presets are data: a new entry adds a command and a button, with a matching entry in `PRESETS` in Rust. */
export const TERMINAL_PRESETS: readonly TerminalPreset[] = [
  {
    id: "claude",
    title: "Claude",
    commandId: "open-claude-in-vault",
    commandTitle: "Open Claude in the vault",
  },
  {
    id: "copilot",
    title: "Copilot",
    commandId: "open-copilot-in-vault",
    commandTitle: "Open Copilot in the vault",
  },
];
