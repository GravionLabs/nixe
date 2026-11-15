# Callouts, highlights and comments

[[_TOC_]]

## Every callout type

> [!note]
> Note with default title.

> [!abstract] Abstract (aliases: summary, tldr)
> Body.

> [!info] Info
> Body.

> [!todo] Todo
> Body.

> [!tip] Tip (aliases: hint, important)
> Body.

> [!success] Success (aliases: check, done)
> Body.

> [!question] Question (aliases: help, faq)
> Body.

> [!warning] Warning (aliases: caution, attention)
> Body.

> [!failure] Failure (aliases: fail, missing)
> Body.

> [!danger] Danger (alias: error)
> Body.

> [!bug] Bug
> Body.

> [!example] Example
> Body.

> [!quote] Quote (alias: cite)
> Body.

> [!tldr]
> Alias with default title.

> [!unknown-type] Unknown type falls back to note
> Body.

## Folding

> [!faq]- Folded, click the title
> Hidden until opened.

> [!tip]+ Expanded, click the title
> Visible until closed.

## Nested

> [!note] Outer
> Outer text.
>
> > [!bug] Inner
> > Inner text with **formatting** and `code`.

## Highlights

This is ==highlighted text== with **==bold highlight==** inside.

## Comments

Visible %%this inline comment is hidden%% text.

%%
This block comment
spans several lines and is hidden.
%%

After the block comment.
