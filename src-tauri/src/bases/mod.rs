//! Bases: a `.base` file shows the notes of the vault as a table. The file is parsed (`parse`) and
//! its view is answered from the vault index; the frontend only renders the result. The rows are
//! the notes that match the filters (`filter`, `expr`, `eval`) of the base and of the view.

mod eval;
mod expr;
mod filter;
mod parse;

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;

use crate::index::read;
use crate::vault::resolve::Resolver;
use eval::Context;
use expr::Field;
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
    /// The name of the note without its extension.
    FileName,
    /// Any other `file.` field.
    File(Field),
    /// A note property, by name.
    Note(String),
}

/// `file.x`, `note.x`, `note["x"]` or a bare `x`; `None` for what is not supported yet.
fn source_of(id: &str) -> Option<Source> {
    if id == FILE_NAME {
        return Some(Source::FileName);
    }
    if let Some(field) = id.strip_prefix("file.") {
        return Field::from_name(field).map(Source::File);
    }
    if id.starts_with("formula.") {
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
        Source::FileName | Source::File(_) => id,
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

fn typed(kind: &str, value: Value) -> BaseCell {
    BaseCell {
        kind: Some(kind.into()),
        value,
    }
}

fn cell(context: &Context, source: &Source) -> BaseCell {
    match source {
        Source::FileName => typed("text", Value::String(context.note.title.clone())),
        Source::File(field) => file_cell(context.field(*field)),
        Source::Note(name) => context
            .property(name)
            .map_or_else(BaseCell::default, |p| typed(&p.kind, p.value.clone())),
    }
}

/// The cell of the value of a `file.` field.
fn file_cell(value: eval::Value) -> BaseCell {
    match value {
        eval::Value::Text(s) => typed("text", s.into()),
        eval::Value::Number(n) => typed("number", (n as u64).into()),
        eval::Value::Date(millis) => {
            chrono::DateTime::from_timestamp_millis(millis).map_or_else(BaseCell::default, |date| {
                let local = date.with_timezone(&chrono::Local);
                typed("date", local.format("%Y-%m-%d %H:%M:%S").to_string().into())
            })
        }
        eval::Value::List(items) => typed(
            "list",
            items.into_iter().map(plain).collect::<Vec<_>>().into(),
        ),
        // `file.properties`, one `key: value` per item.
        eval::Value::Object(entries) => typed(
            "list",
            entries
                .into_iter()
                .map(|(key, value)| {
                    let text = match plain(value) {
                        Value::String(s) => s,
                        Value::Null => String::new(),
                        other => other.to_string(),
                    };
                    Value::String(format!("{key}: {text}"))
                })
                .collect::<Vec<_>>()
                .into(),
        ),
        eval::Value::Null | eval::Value::Bool(_) => BaseCell::default(),
    }
}

/// A value inside a list or a mapping as JSON.
fn plain(value: eval::Value) -> Value {
    match value {
        eval::Value::Null => Value::Null,
        eval::Value::Bool(b) => b.into(),
        // Whole numbers without a fraction, as they are written.
        eval::Value::Number(n) if n.fract() == 0.0 && n.abs() < 1e15 => (n as i64).into(),
        eval::Value::Number(n) => n.into(),
        eval::Value::Text(s) => s.into(),
        eval::Value::Date(millis) => millis.into(),
        eval::Value::List(items) => items.into_iter().map(plain).collect::<Vec<_>>().into(),
        eval::Value::Object(entries) => {
            Value::Object(entries.into_iter().map(|(k, v)| (k, plain(v))).collect())
        }
    }
}

/// Answers the view `view` (default: the first table view) of the base `source` from the index.
/// An error in the filters of the base or of the view is an error of the query: no row is ever
/// hidden or shown by a filter that could not be read.
pub fn query(conn: &Connection, source: &str, view: Option<&str>) -> Result<BaseResult, String> {
    let base = parse::parse(source)?;
    let view = pick(&base, view)?;
    // The global filters and those of the view both have to match.
    let filters = [
        filter::compile(base.filters.as_ref(), "filters")?,
        filter::compile(view.filters.as_ref(), "view filters")?,
    ];

    let mut unsupported: Vec<String> = [(base.formulas, "formulas"), (base.summaries, "summaries")]
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

    let index = read::base_notes(conn).map_err(|e| e.to_string())?;
    let resolver = Resolver::new(&index.files);
    let rows = index
        .notes
        .iter()
        .map(|note| Context {
            note,
            resolver: &resolver,
        })
        .filter(|context| filters.iter().flatten().all(|f| context.matches(f)))
        .map(|context| BaseRow {
            path: context.note.path.clone(),
            cells: sources.iter().map(|s| cell(&context, s)).collect(),
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
