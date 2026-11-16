---
title: Properties and tags
description: One property of every type
count: 42
ratio: 0.75
published: true
draft: false
created: 2026-11-15
updated: 2026-11-15T21:45:00
tags:
  - project/nixe
  - frontmatter
  - übersicht
aliases:
  - Properties demo
  - Frontmatter demo
related: "[[links]]"
see:
  - "[[Home|Wiki home]]"
  - "[[callouts#Every callout type]]"
empty:
---

# Properties and tags

The panel above lists every property type: text, number, checkbox, date, list and link;
`tags` and `aliases` render as chips.

Inline tags: #todo, #project/nixe/v1 and #übersicht are tags. #2026 is not (digits only),
`#code` is not, and neither is a heading:

```
#not-a-tag
```

[a link with a fragment](links.md#anchor) keeps working.
