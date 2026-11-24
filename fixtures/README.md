# Nixe Test Documents

[[_TOC_]]

## Mermaid

- [Mermaid examples](mermaid.md)
- [Mermaid in the "Azure DevOps" section](mermaid.md#azure-devops-format)

## Math

- [LaTeX formulas](math.md)

## Callouts

- [Callouts, highlights and comments](callouts.md)

## Properties and tags

- [Frontmatter properties and #tags](properties.md)
- [Invalid frontmatter](invalid-frontmatter.md)

## Links

- [All link types](links.md)
- [Azure DevOps wiki](wiki/Home.md)

## Code

```ts
export function greet(name: string): string {
  return `Hello ${name}!`;
}
```

- [x] Viewer
- [x] Mermaid
- [ ] World domination

## Books

- `books/sample.epub`: a two-chapter book with a table of contents (the reader specs and the demo).
- `books/script.epub`: the same book with an inline `<script>` and an `onclick` in chapter 1, both of which set `data-script-ran` on the page; the reader must not run them (ADR 0009).
