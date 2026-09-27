# Mermaid-Beispiele

## Standard-Codeblock

```mermaid
flowchart LR
    A[Markdown öffnen] --> B{Mermaid?}
    B -- ja --> C[Diagramm rendern]
    B -- nein --> D[Text anzeigen]
```

## Azure-DevOps-Format

::: mermaid
 sequenceDiagram
     participant U as Nutzer
     participant N as Nixe
     U->>N: Datei öffnen
     N-->>U: Gerendertes Markdown
:::

## Gantt

```mermaid
gantt
    title Nixe Roadmap
    dateFormat YYYY-MM-DD
    section Kern
    Viewer        :done,    v1, 2026-09-01, 7d
    Mermaid       :done,    v2, after v1, 5d
    section Editor
    Split-View    :active,  e1, after v2, 7d
```

## Klassendiagramm (ADO, ohne Leerzeichen)

:::mermaid
classDiagram
    class DocumentService {
      +open(path)
      +save()
    }
    DocumentService --> MarkdownService
:::

## Fehlerhaftes Diagramm

```mermaid
graph TD
    A --> 
    this is not valid
```

Zurück zur [Übersicht](README.md).
