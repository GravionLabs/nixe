//! Bases: a `.base` file shows the notes of the vault as a table or as cards (`cards`). The file is parsed (`parse`) and
//! its view is answered from the vault index; the frontend only renders the result. The rows are
//! the notes that match the filters (`filter`, `expr`, `eval`) of the base and of the view. The
//! `formulas` of the base (`formula`) are columns and values in filters and other formulas. Dates
//! and durations are in `date`; the current time is given to the query. `arrange` sorts, groups
//! and cuts the rows as the view says.

mod arrange;
mod cards;
mod date;
mod eval;
mod expr;
mod filter;
mod formula;
mod functions;
mod parse;

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;

use crate::index::read::{self, NoteFile};
use crate::vault::resolve::Resolver;
pub use arrange::SortKey;
use arrange::{Arrangement, Direction, Groups};
pub use cards::{BaseCards, BaseCover};
use eval::Context;
use expr::Field;
use formula::Formulas;
use parse::{Base, View};

/// The view types that can be shown.
const TABLE: &str = "table";
const CARDS: &str = "cards";
/// Most size of the values of all formula cells of one table.
const MAX_FORMULA_CELLS: usize = 10_000_000;
/// Most size of the formula values all rows are sorted and grouped by.
const MAX_FORMULA_KEYS: usize = 10_000_000;
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
    /// The cover image of the card; `None` in a table and without an image that can be shown.
    pub cover: Option<BaseCover>,
}

/// One group of a grouped table.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BaseGroup {
    /// The value the rows of the group share.
    pub value: BaseCell,
    /// How many of the rows belong to it; they follow those of the groups before it.
    pub rows: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BaseGrouping {
    /// The header of the property the rows are grouped by.
    pub label: String,
    /// The groups in the order they show.
    pub groups: Vec<BaseGroup>,
}

/// A view as the view switcher lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BaseView {
    pub name: Option<String>,
    /// `type`: `table`, `cards`, …
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BaseResult {
    /// The name of the shown view.
    pub view: Option<String>,
    pub columns: Vec<BaseColumn>,
    /// In the order they show: group by group when the view groups them.
    pub rows: Vec<BaseRow>,
    pub grouping: Option<BaseGrouping>,
    /// Set for a view of type `cards`.
    pub cards: Option<BaseCards>,
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

/// The view at `index` of `views`, else the first table view; the error is the message the tab
/// shows.
fn pick(base: &Base, index: Option<usize>) -> Result<&View, String> {
    let view = match index {
        Some(index) => base
            .views
            .get(index)
            .ok_or("The base no longer has this view.")?,
        None => base
            .views
            .iter()
            .find(|v| v.kind == TABLE)
            .or_else(|| base.views.first())
            .ok_or("The base defines no view.")?,
    };
    if view.kind != TABLE && view.kind != CARDS {
        return Err(format!(
            "Views of type \"{}\" are not supported yet; only \"table\" and \"cards\" are.",
            view.kind
        ));
    }
    Ok(view)
}

/// All views of the base `source`, in the order of the file.
pub fn views(source: &str) -> Result<Vec<BaseView>, String> {
    Ok(parse::parse(source)?
        .views
        .into_iter()
        .map(|view| BaseView {
            name: view.name,
            kind: view.kind,
        })
        .collect())
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

/// `room` is what is left of `MAX_FORMULA_CELLS`.
fn cell(context: &Context, source: &Source, room: &mut usize) -> BaseCell {
    match source {
        Source::FileName => typed("text", Value::String(context.note.title.clone())),
        Source::File(field) => value_cell(context.field(*field)),
        Source::Note(name) => context
            .property(name)
            .map_or_else(BaseCell::default, |p| typed(&p.kind, p.value.clone())),
        // An error stays in its cell.
        Source::Formula(name) => {
            formula_cell(context, name, room).unwrap_or_else(|error| typed("error", error.into()))
        }
    }
}

/// The cell of the formula `name`; an error once the formula cells of the table are too large.
fn formula_cell(context: &Context, name: &str, room: &mut usize) -> Result<BaseCell, String> {
    let full = || "the formula values of the table are too large".to_string();
    if *room == 0 {
        return Err(full());
    }
    let value = context.formula(name)?;
    match room.checked_sub(functions::size(&value)?) {
        Some(left) => *room = left,
        None => {
            *room = 0;
            return Err(full());
        }
    }
    Ok(value_cell(value))
}

/// The cell of the value of a `file.` field or of a formula.
fn value_cell(value: eval::Value) -> BaseCell {
    match value {
        eval::Value::Null => BaseCell::default(),
        eval::Value::Bool(b) => typed("checkbox", b.into()),
        eval::Value::Number(n) => typed("number", plain(eval::Value::Number(n))),
        eval::Value::Text(s) => typed("text", s.into()),
        eval::Value::Date(date) => date
            .text()
            .map_or_else(BaseCell::default, |date| typed("date", date.into())),
        eval::Value::Duration(duration) => typed("text", duration.text().into()),
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

/// A value inside a list or a mapping as JSON.
fn plain(value: eval::Value) -> Value {
    match value {
        eval::Value::Null => Value::Null,
        eval::Value::Bool(b) => b.into(),
        // Whole numbers without a fraction, as they are written.
        eval::Value::Number(n) if n.fract() == 0.0 && n.abs() < 1e15 => (n as i64).into(),
        eval::Value::Number(n) => n.into(),
        eval::Value::Text(s) => s.into(),
        eval::Value::Date(date) => date.text().into(),
        eval::Value::Duration(duration) => duration.text().into(),
        eval::Value::List(items) => items.into_iter().map(plain).collect::<Vec<_>>().into(),
        eval::Value::Object(entries) => {
            Value::Object(entries.into_iter().map(|(k, v)| (k, plain(v))).collect())
        }
        eval::Value::Link(link) => link.text().into(),
    }
}

/// What the rows are sorted or grouped by.
struct Key {
    source: Source,
    /// The property id as written.
    id: String,
    direction: Direction,
    /// A formula that fails for a note is an error of the query, so that its row is never silently
    /// moved or cut. False for a sort by a click: such rows come last and show their error.
    strict: bool,
}

impl Key {
    /// `None`, and the part is named in `unsupported`, for a property that is not supported yet.
    fn new(
        key: &SortKey,
        place: &str,
        strict: bool,
        formulas: &Formulas,
        unsupported: &mut Vec<String>,
    ) -> Result<Option<Key>, String> {
        let Some(source) = source_of(&key.property) else {
            unsupported.push(format!("{place} {}", key.property));
            return Ok(None);
        };
        if let (Source::Formula(name), true) = (&source, strict) {
            formulas
                .index(name)
                .and_then(|i| formulas.get(i).map(|_| ()).map_err(str::to_string))
                .map_err(|e| format!("Invalid {place}: {e} in `{}`.", key.property))?;
        }
        Ok(Some(Key {
            source,
            id: key.property.clone(),
            direction: key.direction,
            strict,
        }))
    }

    /// The value of the note; `room` is what is left of `MAX_FORMULA_KEYS`.
    fn value(
        &self,
        context: &Context,
        place: &str,
        room: &mut usize,
    ) -> Result<eval::Value, String> {
        Ok(match &self.source {
            Source::FileName => eval::Value::Text(context.note.title.clone()),
            Source::File(field) => context.field(*field),
            Source::Note(name) => context
                .property(name)
                .map_or(eval::Value::Null, eval::property_value),
            Source::Formula(name) => match context.formula(name) {
                Ok(value) => match room.checked_sub(functions::size(&value)?) {
                    Some(left) => {
                        *room = left;
                        value
                    }
                    // A sort by a click never takes the table away.
                    None if !self.strict => eval::Value::Null,
                    None => return Err("The values to sort and group by are too large.".into()),
                },
                Err(e) if self.strict => {
                    return Err(format!(
                        "Error in {place}: {e} in `{}` for the note `{}`.",
                        self.id, context.note.path
                    ))
                }
                Err(_) => eval::Value::Null,
            },
        })
    }
}

/// A note that matches the filters, with what places its row.
struct Match<'a> {
    note: &'a NoteFile,
    /// One value per sort key.
    keys: Vec<eval::Value>,
    /// The number of its group; 0 without groups.
    group: usize,
}

/// Answers the view at index `view` of `views` (default: the first table view) of the base `source`
/// from the index. `clicked` is a sort chosen in the tab: it comes before the sort of the view.
/// An error in the filters of the base or of the view, also one a note causes, is an error of the
/// query: no row is ever hidden or shown by a filter that could not be applied. An error in the
/// formula of a column shows in its cell. `now` is the current time of `now()`, `today()` and
/// `relative()`, in milliseconds since the Unix epoch: one for the whole table.
///
/// The rows of groups that `groupOrder` hides are dropped, the others are sorted (equal ones stay
/// sorted by path), `limit` keeps the first of them and these are put into their groups.
pub fn query(
    conn: &Connection,
    source: &str,
    view: Option<usize>,
    clicked: Option<&SortKey>,
    now: i64,
) -> Result<BaseResult, String> {
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
    let Arrangement {
        sort,
        group_by,
        group_order,
        limit,
    } = arrange::compile(view)?;

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
    let cards = (view.kind == CARDS)
        .then(|| cards::compile(view, &mut unsupported))
        .transpose()?;
    // Without a column no note could be seen or opened.
    if columns.is_empty() {
        columns.push(BaseColumn {
            id: FILE_NAME.into(),
            label: label(&base, FILE_NAME, &Source::FileName),
        });
        sources.push(Source::FileName);
    }

    let mut sort_keys = Vec::new();
    let clicked = clicked.map(|key| (key, false));
    for (key, strict) in clicked.into_iter().chain(sort.iter().map(|k| (k, true))) {
        sort_keys.extend(Key::new(key, "sort", strict, &formulas, &mut unsupported)?);
    }
    let group_key = match &group_by {
        Some(key) => Key::new(key, "groupBy", true, &formulas, &mut unsupported)?,
        None => None,
    };
    let mut groups = group_key
        .as_ref()
        .map(|key| Groups::new(key.direction, group_order.as_deref()));

    let index = read::base_notes(conn).map_err(|e| e.to_string())?;
    let resolver = Resolver::new(&index.files);
    let mut matches: Vec<Match> = Vec::new();
    let mut key_room = MAX_FORMULA_KEYS;
    // A sort by a click has its own, so it takes nothing from the keys of the view.
    let mut click_room = MAX_FORMULA_KEYS;
    'notes: for note in &index.notes {
        let context = Context::new(note, &resolver, &formulas, now);
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
        let group = match (&group_key, &mut groups) {
            (Some(key), Some(groups)) => {
                match groups.assign(key.value(&context, "groupBy", &mut key_room)?) {
                    Some(group) => group,
                    None => continue,
                }
            }
            _ => 0,
        };
        let keys = sort_keys
            .iter()
            .map(|key| {
                let room = if key.strict {
                    &mut key_room
                } else {
                    &mut click_room
                };
                key.value(&context, "sort", room)
            })
            .collect::<Result<_, _>>()?;
        matches.push(Match { note, keys, group });
    }
    // Stable, so equal rows stay sorted by path.
    matches.sort_by(|a, b| {
        sort_keys
            .iter()
            .zip(a.keys.iter().zip(&b.keys))
            .map(|(key, (a, b))| arrange::compare(a, b, key.direction))
            .find(|order| order.is_ne())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    matches.truncate(limit.unwrap_or(usize::MAX));

    let grouping = match (&group_key, groups) {
        (Some(key), Some(groups)) => {
            let mut sizes = std::collections::HashMap::<usize, usize>::new();
            for m in &matches {
                *sizes.entry(m.group).or_default() += 1;
            }
            let ordered = groups.ordered(|group| sizes.contains_key(&group));
            let places: std::collections::HashMap<usize, usize> = ordered
                .iter()
                .enumerate()
                .map(|(place, (group, _))| (*group, place))
                .collect();
            // Stable, so the rows of a group keep their order.
            matches.sort_by_key(|m| places.get(&m.group).copied());
            Some(BaseGrouping {
                label: label(&base, &key.id, &key.source),
                groups: ordered
                    .into_iter()
                    .map(|(group, value)| BaseGroup {
                        value: value_cell(value),
                        rows: sizes.get(&group).copied().unwrap_or(0),
                    })
                    .collect(),
            })
        }
        _ => None,
    };

    let mut room = MAX_FORMULA_CELLS;
    let rows = matches
        .into_iter()
        .map(|m| {
            let context = Context::new(m.note, &resolver, &formulas, now);
            let cells = sources
                .iter()
                .map(|s| cell(&context, s, &mut room))
                .collect();
            let cover = cards
                .as_ref()
                .and_then(|cards| cards.cover(&context, &resolver, &index.files));
            BaseRow {
                path: m.note.path.clone(),
                cells,
                cover,
            }
        })
        .collect();
    Ok(BaseResult {
        view: view.name.clone(),
        columns,
        rows,
        grouping,
        cards: cards.map(|cards| cards.settings),
        unsupported,
    })
}

#[cfg(test)]
mod tests;
