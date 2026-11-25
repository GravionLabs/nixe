//! Bases: a `.base` file shows the notes of the vault as a table. The file is parsed (`parse`) and
//! its view is answered from the vault index; the frontend only renders the result. The rows are
//! the notes that match the filters (`filter`, `expr`, `eval`) of the base and of the view. The
//! `formulas` of the base (`formula`) are columns and values in filters and other formulas.

mod eval;
mod expr;
mod filter;
mod formula;
mod functions;
mod parse;

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;

use crate::index::read;
use crate::vault::resolve::Resolver;
use eval::Context;
use expr::Field;
use formula::Formulas;
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

/// A value of a row; both are `None` when there is no value.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct BaseCell {
    /// `text`, `number`, `checkbox`, `date`, `list`, `link` (`text`, `path`, `url`) or `error`
    /// (the message).
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
    /// A formula of the base, by name.
    Formula(String),
}

/// `["x"]` or `['x']` after a prefix of a property id.
fn bracketed<'a>(id: &'a str, prefix: &str) -> Option<&'a str> {
    let rest = id
        .strip_prefix(prefix)?
        .strip_prefix('[')?
        .strip_suffix(']')?;
    ['"', '\'']
        .iter()
        .find_map(|&q| rest.strip_prefix(q).and_then(|name| name.strip_suffix(q)))
}

/// `file.x`, `formula.x`, `formula["x"]`, `note.x`, `note["x"]` or a bare `x`; `None` for what is
/// not supported yet.
fn source_of(id: &str) -> Option<Source> {
    if id == FILE_NAME {
        return Some(Source::FileName);
    }
    if let Some(field) = id.strip_prefix("file.") {
        return Field::from_name(field).map(Source::File);
    }
    if let Some(name) = bracketed(id, "formula").or_else(|| id.strip_prefix("formula.")) {
        return Some(Source::Formula(name.to_string()));
    }
    let name = bracketed(id, "note")
        .or_else(|| id.strip_prefix("note."))
        .unwrap_or(id);
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
    let (plain, prefixed) = match source {
        Source::FileName | Source::File(_) => (id, None),
        // `properties` may name a note property with or without the `note.` prefix.
        Source::Note(name) => (name.as_str(), Some(format!("note.{name}"))),
        Source::Formula(name) => (name.as_str(), Some(format!("formula.{name}"))),
    };
    // A formula and a note property of one name have display names of their own.
    let bare = (!matches!(source, Source::Formula(_))).then_some(plain);
    let shown = [Some(id), bare, prefixed.as_deref()]
        .into_iter()
        .flatten()
        .find_map(|key| base.display_names.get(key))
        .cloned();
    shown.unwrap_or_else(|| plain.to_string())
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
        Source::File(field) => value_cell(context.field(*field)),
        Source::Note(name) => context
            .property(name)
            .map_or_else(BaseCell::default, |p| typed(&p.kind, p.value.clone())),
        // An error stays in its cell.
        Source::Formula(name) => context
            .formula(name)
            .map_or_else(|error| typed("error", error.into()), value_cell),
    }
}

/// The cell of the value of a `file.` field or of a formula.
fn value_cell(value: eval::Value) -> BaseCell {
    match value {
        eval::Value::Null => BaseCell::default(),
        eval::Value::Bool(b) => typed("checkbox", b.into()),
        eval::Value::Number(n) => typed("number", plain(eval::Value::Number(n))),
        eval::Value::Text(s) => typed("text", s.into()),
        eval::Value::Date(millis) => {
            local_date(millis).map_or_else(BaseCell::default, |date| typed("date", date.into()))
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
        eval::Value::Link(link) => typed(
            "link",
            serde_json::json!({
                "text": link.text(),
                "path": link.path,
                "url": link.url.then_some(&link.target),
            }),
        ),
    }
}

/// An instant as `YYYY-MM-DD hh:mm:ss` in local time; `None` when it is out of range.
fn local_date(millis: i64) -> Option<String> {
    let local = chrono::DateTime::from_timestamp_millis(millis)?.with_timezone(&chrono::Local);
    Some(local.format("%Y-%m-%d %H:%M:%S").to_string())
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
        eval::Value::Date(millis) => local_date(millis).into(),
        eval::Value::List(items) => items.into_iter().map(plain).collect::<Vec<_>>().into(),
        eval::Value::Object(entries) => {
            Value::Object(entries.into_iter().map(|(k, v)| (k, plain(v))).collect())
        }
        eval::Value::Link(link) => link.text().into(),
    }
}

/// Answers the view `view` (default: the first table view) of the base `source` from the index.
/// An error in the filters of the base or of the view, also one a note causes, is an error of the
/// query: no row is ever hidden or shown by a filter that could not be applied. An error in the
/// formula of a column shows in its cell.
pub fn query(conn: &Connection, source: &str, view: Option<&str>) -> Result<BaseResult, String> {
    let base = parse::parse(source)?;
    let view = pick(&base, view)?;
    let formulas = Formulas::compile(&base.formulas);
    // The global filters and those of the view both have to match.
    let filters = [
        ("filters", base.filters.as_ref()),
        ("view filters", view.filters.as_ref()),
    ]
    .into_iter()
    .map(|(place, value)| {
        filter::compile(value, place, &formulas).map(|filter| filter.map(|f| (place, f)))
    })
    .collect::<Result<Vec<_>, _>>()?;

    let mut unsupported: Vec<String> = Vec::new();
    if base.summaries {
        unsupported.push("summaries".into());
    }
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
    let mut rows = Vec::new();
    'notes: for note in &index.notes {
        let context = Context::new(note, &resolver, &formulas);
        for (place, filter) in filters.iter().flatten() {
            let matches = context.matches(filter).map_err(|e| {
                format!(
                    "Error in {place}: {} in `{}` for the note `{}`.",
                    e.message, e.source, note.path
                )
            })?;
            if !matches {
                continue 'notes;
            }
        }
        rows.push(BaseRow {
            path: note.path.clone(),
            cells: sources.iter().map(|s| cell(&context, s)).collect(),
        });
    }
    Ok(BaseResult {
        view: view.name.clone(),
        columns,
        rows,
        unsupported,
    })
}

#[cfg(test)]
mod tests;
