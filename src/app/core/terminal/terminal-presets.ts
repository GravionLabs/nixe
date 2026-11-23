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

/** Presets that no button or command lists; the Rust core knows them by `id`. */
export const SKILLS_UPDATE_PRESET: TerminalPreset = {
  id: "skills-update",
  title: "Skills update",
  commandId: "update-vault-skills",
  commandTitle: "Update vault skills",
};

export const VAULT_SETUP_PRESET: TerminalPreset = {
  id: "claude-vault-setup",
  title: "Vault setup",
  commandId: "vault-setup-update",
  commandTitle: "Update the vault setup with Claude",
};
