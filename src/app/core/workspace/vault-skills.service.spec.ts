// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ask = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask }));

import { CommandRegistry } from "../commands/command-registry";
import { backend } from "../file/backend";
import { SKILLS_UPDATE_PRESET, VAULT_SETUP_PRESET } from "../terminal/terminal-presets";
import { TerminalService } from "../terminal/terminal.service";
import { VaultSkillsService } from "./vault-skills.service";
import { WorkspaceService } from "./workspace.service";

describe("VaultSkillsService", () => {
  const vaultRoot = signal<string | null>("/v");
  const openPreset = vi.fn();
  let supported = true;

  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

  async function create(hasLock: boolean) {
    vi.spyOn(backend, "isFile").mockResolvedValue(hasLock);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkspaceService, useValue: { vaultRoot } },
        { provide: TerminalService, useValue: { supported, openPreset } },
      ],
    });
    const service = TestBed.inject(VaultSkillsService);
    const commands = TestBed.inject(CommandRegistry);
    await service.refresh();
    return { service, commands };
  }

  const offered = (commands: CommandRegistry) =>
    commands.available().some((c) => c.id === "update-vault-skills");

  beforeEach(() => {
    vi.restoreAllMocks();
    vaultRoot.set("/v");
    supported = true;
    ask.mockReset();
    openPreset.mockReset().mockResolvedValue(true);
  });

  it("offers the command when the vault has skills-lock.json", async () => {
    const { service, commands } = await create(true);
    expect(backend.isFile).toHaveBeenCalledWith("/v/skills-lock.json");
    expect(service.available()).toBe(true);
    expect(offered(commands)).toBe(true);
    expect(commands.all().find((c) => c.id === "update-vault-skills")?.title).toBe(
      "Update vault skills",
    );
  });

  it("does not offer it without skills-lock.json, without a vault or on iOS", async () => {
    const { commands, service } = await create(false);
    expect(offered(commands)).toBe(false);
    await service.update();
    expect(openPreset).not.toHaveBeenCalled();

    vaultRoot.set(null);
    await service.refresh();
    expect(service.available()).toBe(false);

    vaultRoot.set("/v");
    supported = false;
    const ios = await create(true);
    expect(ios.commands.all().some((c) => c.id === "update-vault-skills")).toBe(false);
  });

  it("opens the terminal tab with the skills update", async () => {
    const { service } = await create(true);
    await service.update();
    expect(openPreset).toHaveBeenCalledWith(SKILLS_UPDATE_PRESET, expect.any(Function));
    expect(SKILLS_UPDATE_PRESET.id).toBe("skills-update");
  });

  it("offers /vault-setup update with Claude after the update, and starts it on yes", async () => {
    const { service } = await create(true);
    await service.update();
    const onExit = openPreset.mock.calls[0][1] as () => void;

    ask.mockResolvedValue(true);
    onExit();
    await vi.waitFor(() => expect(openPreset).toHaveBeenCalledWith(VAULT_SETUP_PRESET));
    expect(ask.mock.calls[0][0]).toContain("/vault-setup update");
  });

  it("starts nothing when the offer is declined", async () => {
    const { service } = await create(true);
    await service.update();
    const onExit = openPreset.mock.calls[0][1] as () => void;
    ask.mockResolvedValue(false);
    onExit();
    await vi.waitFor(() => expect(ask).toHaveBeenCalled());
    expect(openPreset).toHaveBeenCalledTimes(1);
  });
});
