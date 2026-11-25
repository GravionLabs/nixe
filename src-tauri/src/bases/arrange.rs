//! Which rows of a view show and in which order: `sort`, `groupBy`, `groupOrder` and `limit`.
//! The keys are those Obsidian writes into a `.base` file. Rows are compared and grouped by values
//! of the language (`eval`); the query (`mod`) reads them from the notes.

use std::cmp::Ordering;
use std::collections::HashMap;

use serde::Deserialize;
use serde_yaml_ng::Value as Yaml;

use super::eval::Value;
use super::functions;
use super::parse::View;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
pub enum Direction {
    #[default]
    #[serde(rename = "ASC")]
    Ascending,
    #[serde(rename = "DESC")]
    Descending,
}

/// A property and the direction rows or groups are ordered in by it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SortKey {
    /// A property id, as in `order`.
    pub property: String,
    #[serde(default)]
    pub direction: Direction,
}

/// The settings of a view.
#[derive(Debug, Default, PartialEq)]
pub struct Arrangement {
    /// The first key counts most.
    pub sort: Vec<SortKey>,
    pub group_by: Option<SortKey>,
    /// The values of the groups that show, in their order.
    pub group_order: Option<Vec<Yaml>>,
    /// Most rows shown.
    pub limit: Option<usize>,
}

/// Reads the settings of the shown view; the error is the message the tab shows.
pub fn compile(view: &View) -> Result<Arrangement, String> {
    let sort = match &view.sort {
        None | Some(Yaml::Null) => Vec::new(),
        Some(Yaml::Mapping(map)) if map.is_empty() => Vec::new(),
        Some(Yaml::Sequence(entries)) => entries
            .iter()
            .map(|entry| sort_key(entry, "sort"))
            .collect::<Result<_, _>>()?,
        Some(_) => return Err("Invalid base: `sort` of the view must be a list.".into()),
    };
    let group_by = match &view.group_by {
        None | Some(Yaml::Null) => None,
        Some(Yaml::Mapping(map)) if map.is_empty() => None,
        Some(value) => Some(sort_key(value, "groupBy")?),
    };
    // Without groups there is nothing to order.
    let group_order = match &view.group_order {
        _ if group_by.is_none() => None,
        None | Some(Yaml::Null) => None,
        Some(Yaml::Sequence(entries)) => Some(entries.clone()),
        Some(_) => return Err("Invalid base: `groupOrder` of the view must be a list.".into()),
    };
    let limit = match &view.limit {
        None | Some(Yaml::Null) => None,
        Some(value) => Some(
            value
                .as_u64()
                .filter(|&n| n > 0)
                .map(|n| usize::try_from(n).unwrap_or(usize::MAX))
                .ok_or("Invalid base: `limit` of the view must be a whole number of 1 or more.")?,
        ),
    };
    Ok(Arrangement {
        sort,
        group_by,
        group_order,
        limit,
    })
}

fn sort_key(value: &Yaml, place: &str) -> Result<SortKey, String> {
    let invalid = |what: &str| format!("Invalid base: `{place}` of the view {what}.");
    let property = value
        .get("property")
        .and_then(Yaml::as_str)
        .ok_or_else(|| invalid("needs a `property`"))?;
    let direction = match value.get("direction") {
        None | Some(Yaml::Null) => Direction::Ascending,
        Some(direction) => match direction.as_str().map(str::to_ascii_uppercase).as_deref() {
            Some("ASC") => Direction::Ascending,
            Some("DESC") => Direction::Descending,
            _ => return Err(invalid("takes the `direction` `ASC` or `DESC`")),
        },
    };
    Ok(SortKey {
        property: property.to_string(),
        direction,
    })
}

/// Whether there is nothing to order a row by: no value, an empty text or an empty list.
fn is_missing(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Text(s) => s.is_empty(),
        Value::List(items) => items.is_empty(),
        _ => false,
    }
}

/// The order of two values in a table. Missing values come last in both directions.
pub fn compare(a: &Value, b: &Value, direction: Direction) -> Ordering {
    match (is_missing(a), is_missing(b)) {
        (false, false) => match direction {
            Direction::Ascending => ascending(a, b),
            Direction::Descending => ascending(b, a),
        },
        (a, b) => a.cmp(&b),
    }
}

/// As the `sort` of a list, but texts ignore case and lists are compared item by item.
fn ascending(a: &Value, b: &Value) -> Ordering {
    match (a, b) {
        (Value::Text(a), Value::Text(b)) => a
            .to_lowercase()
            .cmp(&b.to_lowercase())
            .then_with(|| a.cmp(b)),
        (Value::List(a), Value::List(b)) => a
            .iter()
            .zip(b)
            .map(|(a, b)| ascending(a, b))
            .find(|o| o.is_ne())
            .unwrap_or_else(|| a.len().cmp(&b.len())),
        _ => functions::ascending(a, b),
    }
}

/// The groups of a table while its rows are assigned to them.
pub struct Groups {
    direction: Direction,
    /// The value of each group; its position is the number the rows carry.
    values: Vec<Value>,
    /// The group of a value, by what makes it the same as another.
    known: HashMap<String, usize>,
    /// With `groupOrder` the groups are fixed: one per entry, in that order.
    listed: bool,
}

impl Groups {
    pub fn new(direction: Direction, order: Option<&[Yaml]>) -> Groups {
        let mut groups = Groups {
            direction,
            values: Vec::new(),
            known: HashMap::new(),
            listed: order.is_some(),
        };
        for entry in order.into_iter().flatten() {
            let value = entry_value(entry);
            let key = written(&value);
            // An entry written twice is one group.
            if let std::collections::hash_map::Entry::Vacant(free) = groups.known.entry(key) {
                free.insert(groups.values.len());
                groups.values.push(value);
            }
        }
        groups
    }

    /// The group of a row with `value`; `None` when `groupOrder` hides it.
    pub fn assign(&mut self, value: Value) -> Option<usize> {
        let value = if is_missing(&value) {
            Value::Null
        } else {
            value
        };
        if self.listed {
            return self.known.get(&written(&value)).copied();
        }
        let next = self.values.len();
        let index = *self
            .known
            .entry(functions::identity(&value))
            .or_insert(next);
        if index == next {
            self.values.push(value);
        }
        Some(index)
    }

    /// The groups in the order they show, each with its number and value. `used` says whether a
    /// group has a row: an automatic group without one does not show, a listed one does.
    pub fn ordered(self, used: impl Fn(usize) -> bool) -> Vec<(usize, Value)> {
        let mut groups: Vec<(usize, Value)> = self
            .values
            .into_iter()
            .enumerate()
            .filter(|(i, _)| self.listed || used(*i))
            .collect();
        if !self.listed {
            groups.sort_by(|a, b| compare(&a.1, &b.1, self.direction));
        }
        groups
    }
}

/// The value an entry of `groupOrder` names; `null` is the group of the rows without a value.
fn entry_value(entry: &Yaml) -> Value {
    match entry {
        Yaml::Null => Value::Null,
        Yaml::Bool(b) => Value::Bool(*b),
        Yaml::Number(n) => n.as_f64().map_or(Value::Null, Value::Number),
        Yaml::String(s) if s.is_empty() => Value::Null,
        Yaml::String(s) => Value::Text(s.clone()),
        Yaml::Sequence(items) if items.is_empty() => Value::Null,
        Yaml::Sequence(items) => Value::List(items.iter().map(entry_value).collect()),
        Yaml::Mapping(_) | Yaml::Tagged(_) => Value::Text(
            serde_yaml_ng::to_string(entry)
                .unwrap_or_default()
                .trim()
                .to_string(),
        ),
    }
}

/// A value as it is compared with the entries of `groupOrder`: `3` and `"3"` are the same entry.
fn written(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::List(items) => {
            let items: Vec<String> = items.iter().map(written).collect();
            format!("[{}]", items.join(","))
        }
        other => format!("{:?}", functions::text_of(other)),
    }
}
