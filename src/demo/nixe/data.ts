// The vault of the demo backend (#400): a few notes that link, tag and embed each other, so the
// tree, the editor, backlinks, tags and search have something to show.

/** The folder the demo opens; the page never touches a disk. */
export const VAULT = "/demo/Notes";
export const HOME_NOTE = `${VAULT}/Home.md`;
/** The fixed clock of the screenshots; also the modification time of every seeded note. */
export const TIME = "2026-11-21T09:00:00Z";

export const NOTES: Record<string, string> = {
  "Home.md": `---
title: Home
tags: [index]
---

# Home

Welcome to the demo vault. Start with [[Projects/Nixe]] or read the [[Daily/2026-11-21|daily note]].

## Contents

- [[Projects/Nixe]]: the app this is about
- [[Projects/Helix]]: the design system
- [[Ideas]]: things to try

#index
`,
  "Ideas.md": `# Ideas

- [ ] A graph of the notes
- [x] Backlinks in the side panel
- [ ] Share a note as a link

See [[Projects/Nixe]] for the plan. #idea
`,
  "Projects/Nixe.md": `---
tags: [project, app]
status: active
---

# Nixe

Nixe is a **Markdown vault** app for the desktop. It is built with Tauri and Angular.

| Part | Language |
| --- | --- |
| Core | Rust |
| UI | TypeScript |

> [!note] Design
> The UI is built on [[Projects/Helix]].

\`\`\`ts
const answer: number = 42;
\`\`\`

Back to [[Home]]. #project
`,
  "Projects/Helix.md": `# Helix

The design system of Nixe. Used by [[Projects/Nixe]].

Inline math: $e^{i\\pi} + 1 = 0$

#project #design
`,
  "Daily/2026-11-21.md": `# 2026-11-21

- Wrote the demo backend for [[Projects/Nixe]]
- Look at [[Ideas]] again

#daily
`,
};
