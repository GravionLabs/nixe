# Mermaid Examples

## Standard Code Block

```mermaid
flowchart LR
    A[Open Markdown] --> B{Mermaid?}
    B -- yes --> C[Render diagram]
    B -- no --> D[Show text]
```

## Azure DevOps Format

::: mermaid
 sequenceDiagram
     participant U as User
     participant N as Nixe
     U->>N: Open file
     N-->>U: Rendered Markdown
:::

## Gantt

```mermaid
gantt
    title Nixe Roadmap
    dateFormat YYYY-MM-DD
    section Core
    Viewer        :done,    v1, 2026-09-01, 7d
    Mermaid       :done,    v2, after v1, 5d
    section Editor
    Split View    :active,  e1, after v2, 7d
```

## Class Diagram (ADO, without spaces)

:::mermaid
classDiagram
    class DocumentService {
      +open(path)
      +save()
    }
    DocumentService --> MarkdownService
:::

## Broken Diagram

```mermaid
graph TD
    A --> 
    this is not valid
```

Back to the [overview](README.md).
