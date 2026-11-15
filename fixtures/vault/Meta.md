---
title: Meta demo
count: 3
published: true
created: 2026-11-15
tags: [project/nixe, "#Frontmatter"]
aliases: [Meta alias]
---

# Meta

Links: [[Note]], [[Note|alias]], [[Note#Second heading]], [[Note#^block1|shown]], [[#Meta]] and ![[Note]].

Markdown links: [a note](Note.md), [with heading](folder/Deep.md#Top), [spaced](Loop%20A.md),
[web](https://example.com/a.md), [anchor](#meta), [image file](assets/image.svg).

Inline tags: #todo and #project/nixe/v1 and #übersicht. #2026 is not a tag.

Skipped: `[[code]] #code` and

```
[[fence]] #fence ^fenceid
```

%% hidden [[comment]] #hidden %% visible [[after]]

%%
multi-line [[comment2]] #hidden2
%%

## Sub heading ##

A paragraph with a block id. ^para-1
