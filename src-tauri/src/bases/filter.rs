//! The `filters` of a base or of a view: an expression, or a mapping with one of `and`, `or` and
//! `not` over a list of filters.

use serde_yaml_ng::Value;

use super::eval::Filter;
use super::expr;

/// Most nested groups.
const MAX_DEPTH: usize = 50;

/// Compiles the filters at `place` (`filters`, `view filters`); `None` when there are none. The
/// error names the place and the expression, it is the message the tab shows.
pub fn compile(value: Option<&Value>, place: &str) -> Result<Option<Filter>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
        Some(Value::Mapping(map)) if map.is_empty() => Ok(None),
        Some(Value::Sequence(list)) if list.is_empty() => Ok(None),
        Some(value) => filter(value, 0)
            .map(Some)
            .map_err(|e| format!("Invalid {place}: {e}")),
    }
}

fn filter(value: &Value, depth: usize) -> Result<Filter, String> {
    if depth > MAX_DEPTH {
        return Err("the groups are nested too deeply.".into());
    }
    match value {
        Value::String(source) => expr::parse(source)
            .map(Filter::Expr)
            .map_err(|e| format!("{e} in `{source}`.")),
        Value::Mapping(map) if map.len() == 1 => {
            let (key, entries) = map.iter().next().ok_or("an empty group.")?;
            let group: fn(Vec<Filter>) -> Filter = match key.as_str() {
                Some("and") => Filter::And,
                Some("or") => Filter::Or,
                Some("not") => Filter::Not,
                _ => {
                    return Err(format!(
                        "unknown key `{}`; use `and`, `or` or `not`.",
                        written(key)
                    ))
                }
            };
            let entries = match entries {
                Value::Null => &[],
                Value::Sequence(list) => list.as_slice(),
                other => {
                    return Err(format!(
                        "`{}` needs a list, found `{}`.",
                        written(key),
                        written(other)
                    ))
                }
            };
            entries
                .iter()
                .map(|entry| filter(entry, depth + 1))
                .collect::<Result<_, _>>()
                .map(group)
        }
        other => Err(format!(
            "expected an expression or one of `and`, `or`, `not`, found `{}`.",
            written(other)
        )),
    }
}

/// A YAML value on one line, for a message.
fn written(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => serde_yaml_ng::to_string(other)
            .unwrap_or_default()
            .trim()
            .replace('\n', " "),
    }
}
