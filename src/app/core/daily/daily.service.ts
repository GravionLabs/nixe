import { Injectable, inject } from "@angular/core";

import { EditorService } from "../editor/editor.service";
import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { dirname, joinPath } from "../markdown/paths";
import { SettingsService } from "../settings/settings.service";
import { expandTemplate } from "../templates/template-core";
import { WorkspaceService } from "../workspace/workspace.service";
import type { DailyConfig } from "./daily-core";
import { dailyPath, neighborDaily, parseDailyPath, trimSlashes } from "./daily-core";

/** The daily notes: today's note, created from its template, and the ones before and after. */
@Injectable({ providedIn: "root" })
export class DailyService {
  private readonly workspace = inject(WorkspaceService);
  private readonly doc = inject(DocumentService);
  private readonly editor = inject(EditorService);
  private readonly settings = inject(SettingsService);

  /** Each key from `.obsidian/daily-notes.json`, else from the settings. */
  async config(): Promise<DailyConfig> {
    const vault = await backend.dailyNotesConfig().catch(() => null);
    return {
      folder: trimSlashes(vault?.folder ?? "") || trimSlashes(this.settings.dailyFolder()),
      format: vault?.format?.trim() || this.settings.dailyFormat().trim(),
      template: trimSlashes(vault?.template ?? "") || trimSlashes(this.settings.dailyTemplate()),
    };
  }

  /** Opens the daily note of today; a missing one is created from the template first. */
  async openToday(now: Date = new Date()): Promise<void> {
    const root = this.vaultRoot();
    const config = await this.config();
    const path = joinPath(root, dailyPath(now, config));
    if (!(await backend.isFile(path))) await this.create(root, path, config, now);
    await this.open(path);
  }

  /** Opens the nearest daily note before the open one (or today when the open note is none). */
  previous(now: Date = new Date()): Promise<void> {
    return this.step(-1, now);
  }

  /** Opens the nearest daily note after the open one (or today when the open note is none). */
  next(now: Date = new Date()): Promise<void> {
    return this.step(1, now);
  }

  private async step(direction: -1 | 1, now: Date): Promise<void> {
    const root = this.vaultRoot();
    const config = await this.config();
    const current = this.doc.path();
    const rel = current?.startsWith(`${root}/`) ? current.slice(root.length + 1) : null;
    const from = (rel && parseDailyPath(rel, config)) || now;
    const found = neighborDaily(this.workspace.vaultFiles() ?? [], from, direction, config);
    if (!found) throw new Error(`No ${direction < 0 ? "previous" : "next"} daily note.`);
    await this.open(joinPath(root, found));
  }

  private vaultRoot(): string {
    const root = this.workspace.vaultRoot();
    if (!root) throw new Error("Open a vault to use daily notes.");
    return root;
  }

  private async create(root: string, path: string, config: DailyConfig, now: Date): Promise<void> {
    let text = "";
    if (config.template) {
      const file = /\.md$/iu.test(config.template) ? config.template : `${config.template}.md`;
      text = await backend.readTextFile(joinPath(root, file)).catch(() => {
        throw new Error(`Daily note template not found: ${file}`);
      });
    }
    const title = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/iu, "");
    await backend.createDir(dirname(path));
    await backend.createFile(path);
    if (text) await backend.writeTextFile(path, expandTemplate(text, { title, now }));
    await this.workspace.reloadTree();
  }

  private async open(path: string): Promise<void> {
    await this.editor.handle?.flush();
    await this.doc.open(path);
  }
}
