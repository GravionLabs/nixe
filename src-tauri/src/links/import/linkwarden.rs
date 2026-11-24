//! The Linkwarden JSON backup: `{"collections": [{"id", "name", "parentId", "links": [{"name",
//! "url", "description", "createdAt", "tags": [{"name"}]}]}]}`. A collection with a `parentId`
//! lies below its parent, so its links land in nested subfolders.

use std::collections::HashMap;

use serde_json::Value;

use super::{saved_from_iso, Entry};

/// Whether `value` looks like a Linkwarden backup.
pub fn is_backup(value: &Value) -> bool {
    value.get("collections").is_some_and(Value::is_array)
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn parse(value: &Value) -> Result<Vec<Entry>, String> {
    let collections = value
        .get("collections")
        .and_then(Value::as_array)
        .ok_or("the backup has no `collections`")?;
    let parents: HashMap<i64, (Option<String>, Option<i64>)> = collections
        .iter()
        .filter_map(|c| {
            Some((
                c.get("id")?.as_i64()?,
                (text(c, "name"), c.get("parentId").and_then(Value::as_i64)),
            ))
        })
        .collect();
    // Outermost first; the step limit guards against a parent cycle.
    let path = |c: &Value| -> Vec<String> {
        let mut names = Vec::new();
        let mut name = text(c, "name");
        let mut parent = c.get("parentId").and_then(Value::as_i64);
        for _ in 0..=parents.len() {
            names.extend(name.take());
            let Some((n, p)) = parent.and_then(|id| parents.get(&id)) else {
                break;
            };
            name = n.clone();
            parent = *p;
        }
        names.reverse();
        names
    };
    let mut entries = Vec::new();
    for collection in collections {
        let folders = path(collection);
        for link in collection
            .get("links")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(url) = text(link, "url") else {
                continue;
            };
            entries.push(Entry {
                url,
                title: text(link, "name"),
                tags: link
                    .get("tags")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|t| text(t, "name"))
                    .collect(),
                saved: text(link, "createdAt").and_then(|c| saved_from_iso(&c)),
                read: false,
                folders: folders.clone(),
                description: text(link, "description"),
                note: None,
            });
        }
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::from_str(
            &std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../fixtures/import/linkwarden.json"),
            )
            .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn nested_collections_tags_description_and_created() {
        let entries = parse(&fixture()).unwrap();
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].folders, ["Dev"]);
        assert_eq!(entries[0].title.as_deref(), Some("Linkwarden docs"));
        assert_eq!(entries[0].tags, ["docs", "self-hosted"]);
        assert_eq!(
            entries[0].description.as_deref(),
            Some("How the backup looks")
        );
        assert_eq!(
            entries[0].saved.as_deref(),
            Some("2023-11-14T22:13:20+00:00")
        );
        assert_eq!(entries[1].folders, ["Dev", "Rust"]);
        assert_eq!(entries[1].title, None);
        assert_eq!(entries[1].description, None);
        assert_eq!(entries[3].folders, ["Loose"]);
    }

    #[test]
    fn a_parent_cycle_does_not_hang() {
        let v: Value = serde_json::from_str(
            r#"{"collections":[{"id":1,"name":"A","parentId":2,"links":[{"url":"https://a.test/"}]},
                {"id":2,"name":"B","parentId":1,"links":[]}]}"#,
        )
        .unwrap();
        assert_eq!(parse(&v).unwrap().len(), 1);
    }

    #[test]
    fn only_a_backup_has_collections() {
        assert!(is_backup(&fixture()));
        assert!(!is_backup(&serde_json::json!({"links": []})));
        assert!(parse(&serde_json::json!({})).is_err());
    }
}
