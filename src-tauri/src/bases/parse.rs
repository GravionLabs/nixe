//! The YAML of a `.base` file (<https://obsidian.md/help/bases/syntax>). The keys `filters`,
//! `formulas`, `properties`, `summaries` and `views` are read, every other key is ignored. What is
//! read but not applied yet is only checked for being there, so the query can name it. Filters are
//! kept as written and compiled (`filter`) for the shown view only.

use std::collections::HashMap;

use serde_yaml_ng::{Mapping, Value};

/// A parsed `.base` file.
#[derive(Debug, Default, PartialEq)]
pub struct Base {
    /// Filters of every view, as written.
    pub filters: Option<Value>,
    /// Formula definitions; not evaluated yet.
    pub formulas: bool,
    /// Custom summary formulas; not evaluated yet.
    pub summaries: bool,
    /// `displayName` of `properties`, by property id as written in the file.
    pub display_names: HashMap<String, String>,
    pub views: Vec<View>,
}

/// One entry of `views`.
#[derive(Debug, Default, PartialEq)]
pub struct View {
    /// `type`: `table`, `cards`, …
    pub kind: String,
    pub name: Option<String>,
    /// The columns, as property ids; empty when the view has no `order`.
    pub order: Vec<String>,
    /// The filters of this view, as written.
    pub filters: Option<Value>,
    /// The keys of the view that are there but not applied yet.
    pub unsupported: Vec<&'static str>,
}

/// View keys that change which rows show or how, with the name the message gives them.
const UNSUPPORTED_VIEW_KEYS: &[(&str, &str)] = &[
    ("sort", "sort"),
    ("groupBy", "groupBy"),
    ("limit", "limit"),
    ("summaries", "view summaries"),
];

/// Reads the source of a `.base` file; the error is the message the tab shows.
pub fn parse(source: &str) -> Result<Base, String> {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let value: Value = serde_yaml_ng::from_str(source).map_err(|e| format!("Invalid YAML: {e}"))?;
    let map = match value {
        // An empty file, or one with comments only.
        Value::Null => return Ok(Base::default()),
        Value::Mapping(map) => map,
        _ => return Err("Invalid base: the file must be a YAML mapping.".into()),
    };
    let views = match map.get("views") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Sequence(items)) => items.iter().map(view).collect::<Result<_, _>>()?,
        Some(_) => return Err("Invalid base: `views` must be a list.".into()),
    };
    Ok(Base {
        filters: map.get("filters").cloned(),
        formulas: is_set(map.get("formulas")),
        summaries: is_set(map.get("summaries")),
        display_names: display_names(map.get("properties"))?,
        views,
    })
}

fn view(value: &Value) -> Result<View, String> {
    let Value::Mapping(map) = value else {
        return Err("Invalid base: every view must be a mapping.".into());
    };
    let Some(kind) = text(map, "type") else {
        return Err("Invalid base: every view needs a `type`.".into());
    };
    let order = match map.get("order") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Sequence(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_string))
            .collect::<Option<_>>()
            .ok_or("Invalid base: `order` must be a list of property names.")?,
        Some(_) => return Err("Invalid base: `order` must be a list of property names.".into()),
    };
    Ok(View {
        kind,
        name: text(map, "name"),
        order,
        filters: map.get("filters").cloned(),
        unsupported: UNSUPPORTED_VIEW_KEYS
            .iter()
            .filter(|(key, _)| is_set(map.get(*key)))
            .map(|(_, label)| *label)
            .collect(),
    })
}

fn display_names(value: Option<&Value>) -> Result<HashMap<String, String>, String> {
    let map = match value {
        None | Some(Value::Null) => return Ok(HashMap::new()),
        Some(Value::Mapping(map)) => map,
        Some(_) => return Err("Invalid base: `properties` must be a mapping.".into()),
    };
    Ok(map
        .iter()
        .filter_map(|(id, config)| {
            let name = text(config.as_mapping()?, "displayName")?;
            Some((id.as_str()?.to_string(), name))
        })
        .collect())
}

fn text(map: &Mapping, key: &str) -> Option<String> {
    map.get(key).and_then(Value::as_str).map(str::to_string)
}

/// True when the key holds something: not missing, null or an empty string, list or mapping.
fn is_set(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::String(s)) => !s.trim().is_empty(),
        Some(Value::Sequence(s)) => !s.is_empty(),
        Some(Value::Mapping(m)) => !m.is_empty(),
        Some(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: &str = r#"
filters:
  and:
    - file.hasTag("book")
formulas:
  ppu: "(price / age).toFixed(2)"
properties:
  status:
    displayName: Status
  file.name:
    displayName: Note
  note.age:
    other: ignored
summaries:
  customAverage: 'values.mean().round(3)'
views:
  - type: table
    name: My table
    limit: 10
    groupBy: { property: note.age, direction: DESC }
    filters: 'status != "done"'
    sort:
      - { property: note.age, direction: ASC }
    summaries: { formula.ppu: Average }
    order: [file.name, note.age]
    columnSize: { file.name: 200 }
  - type: cards
unknown: { nested: true }
"#;

    #[test]
    fn reads_every_key_and_ignores_unknown_ones() {
        let base = parse(FULL).unwrap();
        assert!(base.filters.is_some() && base.formulas && base.summaries);
        assert_eq!(base.display_names.len(), 2);
        assert_eq!(base.display_names["status"], "Status");
        assert_eq!(base.display_names["file.name"], "Note");
        assert_eq!(base.views.len(), 2);
        let table = &base.views[0];
        assert_eq!(table.kind, "table");
        assert_eq!(table.name.as_deref(), Some("My table"));
        assert_eq!(table.order, ["file.name", "note.age"]);
        assert_eq!(
            table.unsupported,
            ["sort", "groupBy", "limit", "view summaries"]
        );
        assert_eq!(table.filters, Some(Value::from("status != \"done\"")));
        assert_eq!(base.views[1].kind, "cards");
        assert!(base.views[1].order.is_empty() && base.views[1].unsupported.is_empty());
    }

    #[test]
    fn an_empty_file_and_empty_keys_hold_nothing() {
        assert_eq!(parse("").unwrap(), Base::default());
        assert_eq!(parse("# only a comment\n").unwrap(), Base::default());
        let base = parse("\u{feff}filters:\nformulas: {}\nsummaries: []\nviews:\n").unwrap();
        assert_eq!(base.filters, Some(Value::Null));
        assert!(!base.formulas && !base.summaries && base.views.is_empty());
    }

    #[test]
    fn invalid_yaml_and_wrong_shapes_are_errors() {
        let broken = parse("views: [unclosed").unwrap_err();
        assert!(broken.starts_with("Invalid YAML: "), "{broken}");
        for (source, wanted) in [
            ("- a list", "YAML mapping"),
            ("just text", "YAML mapping"),
            ("views: table", "`views` must be a list"),
            ("views: [table]", "every view must be a mapping"),
            ("views: [{ name: x }]", "needs a `type`"),
            (
                "views: [{ type: table, order: file.name }]",
                "`order` must be",
            ),
            ("views: [{ type: table, order: [1] }]", "`order` must be"),
            ("properties: [a]", "`properties` must be a mapping"),
        ] {
            let error = parse(source).unwrap_err();
            assert!(error.contains(wanted), "{source}: {error}");
        }
    }
}
