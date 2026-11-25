//! Bases: a `.base` file shows the notes of the vault as a table. The file is parsed (`parse`) and
//! its view is answered from the vault index; the frontend only renders the result.

mod parse;

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;

use crate::index::read::{self, NoteProperties};
use parse::{Base, View};

/// The view type that can be shown.
const TABLE: &str = "table";
/// The property id of the column with the name of the note.
const FILE_NAME: &str = "file.name";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BaseColumn {
    /// The property id as written in `order`.
    pub id: String,
    /// The header: the `displayName` of the property, else its name.
    pub label: String,
}

/// A value of a row; both are `None` when the note has no such property.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct BaseCell {
    /// `text`, `number`, `checkbox`, `date` or `list`.
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BaseRow {
    /// Vault-relative path of the note.
    pub path: String,
    /// One cell per column, in their order.
    pub cells: Vec<BaseCell>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BaseResult {
    /// The name of the shown view.
    pub view: Option<String>,
    pub columns: Vec<BaseColumn>,
    pub rows: Vec<BaseRow>,
    /// The parts of the file that are not supported yet and therefore not applied.
    pub unsupported: Vec<String>,
}

/// What a column shows.
enum Source {
    FileName,
    /// A note property, by name.
    Note(String),
}

/// `file.name`, `note.x`, `note["x"]` or a bare `x`; `None` for what is not supported yet.
fn source_of(id: &str) -> Option<Source> {
    if id == FILE_NAME {
        return Some(Source::FileName);
    }
    if id.starts_with("file.") || id.starts_with("formula.") {
        return None;
    }
    let quoted = id
        .strip_prefix("note[")
        .and_then(|rest| rest.strip_suffix(']'))
        .and_then(|rest| {
            ['"', '\'']
                .iter()
                .find_map(|&q| rest.strip_prefix(q).and_then(|name| name.strip_suffix(q)))
        });
    let name = quoted.or_else(|| id.strip_prefix("note.")).unwrap_or(id);
    Some(Source::Note(name.to_string()))
}

/// The view `name`, else the first table view; the error is the message the tab shows.
fn pick<'a>(base: &'a Base, name: Option<&str>) -> Result<&'a View, String> {
    let view = match name {
        Some(name) => base
            .views
            .iter()
            .find(|v| v.name.as_deref() == Some(name))
            .ok_or_else(|| format!("The base has no view named \"{name}\"."))?,
        None => base
            .views
            .iter()
            .find(|v| v.kind == TABLE)
            .or_else(|| base.views.first())
            .ok_or("The base defines no view.")?,
    };
    if view.kind != TABLE {
        return Err(format!(
            "Views of type \"{}\" are not supported yet; only \"table\" is.",
            view.kind
        ));
    }
    Ok(view)
}

fn label(base: &Base, id: &str, source: &Source) -> String {
    let plain = match source {
        Source::FileName => FILE_NAME,
        Source::Note(name) => name,
    };
    // `properties` may name a note property with or without the `note.` prefix.
    let prefixed = format!("note.{plain}");
    [id, plain, &prefixed]
        .iter()
        .find_map(|key| base.display_names.get(*key))
        .cloned()
        .unwrap_or_else(|| plain.to_string())
}

fn cell(note: &NoteProperties, source: &Source) -> BaseCell {
    match source {
        Source::FileName => BaseCell {
            kind: Some("text".into()),
            value: Value::String(note.title.clone()),
        },
        Source::Note(name) => {
            let wanted = name.to_lowercase();
            // The exact key wins over one that differs in case only.
            note.properties
                .iter()
                .find(|p| p.key == *name)
                .or_else(|| {
                    note.properties
                        .iter()
                        .find(|p| p.key.to_lowercase() == wanted)
                })
                .map_or_else(BaseCell::default, |p| BaseCell {
                    kind: Some(p.kind.clone()),
                    value: p.value.clone(),
                })
        }
    }
}

/// Answers the view `view` (default: the first table view) of the base `source` from the index.
pub fn query(conn: &Connection, source: &str, view: Option<&str>) -> Result<BaseResult, String> {
    let base = parse::parse(source)?;
    let view = pick(&base, view)?;

    let mut unsupported: Vec<String> = [
        (base.filters, "filters"),
        (base.formulas, "formulas"),
        (base.summaries, "summaries"),
    ]
    .iter()
    .filter(|(set, _)| *set)
    .map(|(_, name)| name.to_string())
    .collect();
    unsupported.extend(view.unsupported.iter().map(|s| s.to_string()));

    let mut columns = Vec::new();
    let mut sources = Vec::new();
    for id in &view.order {
        match source_of(id) {
            Some(source) => {
                columns.push(BaseColumn {
                    id: id.clone(),
                    label: label(&base, id, &source),
                });
                sources.push(source);
            }
            None => unsupported.push(format!("column {id}")),
        }
    }
    // Without a column no note could be seen or opened.
    if columns.is_empty() {
        columns.push(BaseColumn {
            id: FILE_NAME.into(),
            label: label(&base, FILE_NAME, &Source::FileName),
        });
        sources.push(Source::FileName);
    }

    let rows = read::notes_with_properties(conn)
        .map_err(|e| e.to_string())?
        .iter()
        .map(|note| BaseRow {
            path: note.path.clone(),
            cells: sources.iter().map(|s| cell(note, s)).collect(),
        })
        .collect();
    Ok(BaseResult {
        view: view.name.clone(),
        columns,
        rows,
        unsupported,
    })
}

#[cfg(test)]
mod tests;
