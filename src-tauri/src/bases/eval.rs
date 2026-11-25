//! Evaluation of expressions and filters on the notes of the index. A note that lacks a property,
//! or holds one of another type, is never an error: the operation has no value, which is false.

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone};
use serde_json::Value as Json;

use super::expr::{Expr, Field, Function, Op};
use crate::index::read::{IndexedProperty, NoteFile};
use crate::vault::resolve::{parse_target, Resolver};

/// A value of the language.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    Text(String),
    /// Milliseconds since the Unix epoch.
    Date(i64),
    List(Vec<Value>),
    /// `file.properties` and mappings in the frontmatter.
    Object(Vec<(String, Value)>),
}

impl Value {
    /// False for no value, `false`, `0` and an empty text, list or mapping.
    pub fn is_true(&self) -> bool {
        match self {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::Number(n) => *n != 0.0 && !n.is_nan(),
            Value::Text(s) => !s.is_empty(),
            Value::Date(_) => true,
            Value::List(items) => !items.is_empty(),
            Value::Object(entries) => !entries.is_empty(),
        }
    }

    fn from_json(json: &Json) -> Value {
        match json {
            Json::Null => Value::Null,
            Json::Bool(b) => Value::Bool(*b),
            Json::Number(n) => n.as_f64().map_or(Value::Null, Value::Number),
            Json::String(s) => Value::Text(s.clone()),
            Json::Array(items) => Value::List(items.iter().map(Value::from_json).collect()),
            Json::Object(map) => Value::Object(
                map.iter()
                    .map(|(k, v)| (k.clone(), Value::from_json(v)))
                    .collect(),
            ),
        }
    }
}

/// The filters of a base or of a view.
#[derive(Debug, Clone, PartialEq)]
pub enum Filter {
    Expr(Expr),
    /// True when every entry is.
    And(Vec<Filter>),
    /// True when at least one entry is, and when there is none.
    Or(Vec<Filter>),
    /// True when no entry is.
    Not(Vec<Filter>),
}

/// What an expression is evaluated on.
pub struct Context<'a> {
    pub note: &'a NoteFile,
    /// Resolves link targets against the files of the vault.
    pub resolver: &'a Resolver,
}

impl Context<'_> {
    pub fn matches(&self, filter: &Filter) -> bool {
        match filter {
            Filter::Expr(expr) => self.eval(expr).is_true(),
            Filter::And(all) => all.iter().all(|f| self.matches(f)),
            // A group without entries sets no condition.
            Filter::Or(any) => any.is_empty() || any.iter().any(|f| self.matches(f)),
            Filter::Not(none) => !none.iter().any(|f| self.matches(f)),
        }
    }

    pub fn eval(&self, expr: &Expr) -> Value {
        match expr {
            Expr::Text(s) => Value::Text(s.clone()),
            Expr::Number(n) => Value::Number(*n),
            Expr::Bool(b) => Value::Bool(*b),
            Expr::List(items) => Value::List(items.iter().map(|i| self.eval(i)).collect()),
            Expr::Property(name) => self
                .property(name)
                .map_or(Value::Null, |p| Value::from_json(&p.value)),
            Expr::File(field) => self.field(*field),
            Expr::Call(function, args) => {
                let args: Vec<Value> = args.iter().map(|a| self.eval(a)).collect();
                Value::Bool(self.call(*function, &args))
            }
            Expr::Not(inner) => Value::Bool(!self.eval(inner).is_true()),
            Expr::Negate(inner) => match self.eval(inner) {
                Value::Number(n) => Value::Number(-n),
                _ => Value::Null,
            },
            Expr::Binary(op, left, right) => {
                let left = self.eval(left);
                match op {
                    Op::And => Value::Bool(left.is_true() && self.eval(right).is_true()),
                    Op::Or => Value::Bool(left.is_true() || self.eval(right).is_true()),
                    _ => binary(*op, &left, &self.eval(right)),
                }
            }
        }
    }

    /// The property `name`; the exact key wins over one that differs in case only.
    pub fn property(&self, name: &str) -> Option<&IndexedProperty> {
        let wanted = name.to_lowercase();
        let properties = &self.note.properties;
        properties
            .iter()
            .find(|p| p.key == name)
            .or_else(|| properties.iter().find(|p| p.key.to_lowercase() == wanted))
    }

    pub fn field(&self, field: Field) -> Value {
        let note = self.note;
        let path = note.path.as_str();
        let (folder, name) = path.rsplit_once('/').unwrap_or(("", path));
        let ext = name.rsplit_once('.').map_or("", |(_, ext)| ext);
        let text = |s: &str| Value::Text(s.to_string());
        let list = |items: Vec<&str>| {
            let mut seen = std::collections::HashSet::new();
            Value::List(
                items
                    .into_iter()
                    .filter(|s| seen.insert(*s))
                    .map(text)
                    .collect(),
            )
        };
        // A link of a note to one of its own headings is none to a file.
        let links = |embeds: bool| {
            list(
                note.links
                    .iter()
                    .filter(|l| l.embed == embeds && !l.target.is_empty())
                    .map(|l| l.resolved.as_deref().unwrap_or(&l.target))
                    .collect(),
            )
        };
        match field {
            Field::Name => text(name),
            Field::Basename => text(&note.title),
            Field::Path => text(path),
            Field::Folder => text(folder),
            Field::Ext => text(ext),
            Field::Size => Value::Number(note.size as f64),
            Field::Ctime => Value::Date(note.ctime_ns.div_euclid(1_000_000)),
            Field::Mtime => Value::Date(note.mtime_ns.div_euclid(1_000_000)),
            Field::Tags => list(note.tags.iter().map(String::as_str).collect()),
            Field::Links => links(false),
            Field::Embeds => links(true),
            Field::Backlinks => list(note.backlinks.iter().map(String::as_str).collect()),
            Field::Properties => Value::Object(
                note.properties
                    .iter()
                    .map(|p| (p.key.clone(), Value::from_json(&p.value)))
                    .collect(),
            ),
        }
    }

    fn call(&self, function: Function, args: &[Value]) -> bool {
        // The parser checked the number of arguments; a list counts as its items.
        let mut texts = Vec::new();
        for arg in args {
            match arg {
                Value::Text(s) => texts.push(s.as_str()),
                Value::List(items) => texts.extend(items.iter().filter_map(|i| match i {
                    Value::Text(s) => Some(s.as_str()),
                    _ => None,
                })),
                _ => {}
            }
        }
        texts.iter().any(|arg| match function {
            Function::HasTag => self.has_tag(arg),
            Function::InFolder => self.in_folder(arg),
            Function::HasLink => self.has_link(arg),
            Function::HasProperty => self.property(arg).is_some(),
        })
    }

    /// The tag itself or one nested below it, ignoring case and a leading `#`.
    fn has_tag(&self, tag: &str) -> bool {
        let wanted = tag
            .trim_start_matches('#')
            .trim_end_matches('/')
            .to_lowercase();
        !wanted.is_empty()
            && self.note.tags.iter().any(|t| {
                t.to_lowercase()
                    .strip_prefix(&wanted)
                    .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
            })
    }

    /// In the folder or below it; every note is in the root (`""` or `/`).
    fn in_folder(&self, folder: &str) -> bool {
        let folder = folder.trim_matches('/');
        let folder = folder.strip_prefix("./").unwrap_or(folder);
        folder.is_empty()
            || self
                .note
                .path
                .strip_prefix(folder)
                .is_some_and(|rest| rest.starts_with('/'))
    }

    /// A link or embed to the file `target` names (a path, a name or `[[…]]`). A target that is no
    /// file of the vault matches links written the same way, ignoring case.
    fn has_link(&self, target: &str) -> bool {
        let target = target.trim();
        let target = target.strip_prefix('!').unwrap_or(target);
        let target = target
            .strip_prefix("[[")
            .and_then(|t| t.strip_suffix("]]"))
            .map_or(target, |t| t.split('|').next().unwrap_or(t));
        let name = parse_target(target).note;
        if name.is_empty() {
            return false;
        }
        match self.resolver.resolve(target) {
            Some(path) => self
                .note
                .links
                .iter()
                .any(|l| !l.target.is_empty() && l.resolved.as_deref() == Some(path.as_str())),
            None => {
                let name = name.to_lowercase();
                self.note
                    .links
                    .iter()
                    .any(|l| parse_target(&l.target).note.to_lowercase() == name)
            }
        }
    }
}

/// Every operator but `&&` and `||`.
fn binary(op: Op, left: &Value, right: &Value) -> Value {
    use std::cmp::Ordering::{Equal, Greater, Less};
    let ordered = |wanted: &[std::cmp::Ordering]| {
        Value::Bool(order(left, right).is_some_and(|o| wanted.contains(&o)))
    };
    match op {
        Op::Eq => Value::Bool(equal(left, right)),
        Op::Ne => Value::Bool(!equal(left, right)),
        Op::Lt => ordered(&[Less]),
        Op::Le => ordered(&[Less, Equal]),
        Op::Gt => ordered(&[Greater]),
        Op::Ge => ordered(&[Greater, Equal]),
        Op::Add => match (left, right) {
            (Value::Number(a), Value::Number(b)) => Value::Number(a + b),
            (Value::Text(a), Value::Text(b)) => Value::Text(format!("{a}{b}")),
            (Value::Text(a), Value::Number(b)) => Value::Text(format!("{a}{b}")),
            (Value::Number(a), Value::Text(b)) => Value::Text(format!("{a}{b}")),
            _ => Value::Null,
        },
        Op::Sub | Op::Mul | Op::Div | Op::Rem => match (left, right) {
            (Value::Number(a), Value::Number(b)) => {
                let result = match op {
                    Op::Sub => a - b,
                    Op::Mul => a * b,
                    Op::Div => a / b,
                    _ => a % b,
                };
                // A division by zero has no value.
                if result.is_finite() {
                    Value::Number(result)
                } else {
                    Value::Null
                }
            }
            _ => Value::Null,
        },
        Op::And | Op::Or => Value::Null,
    }
}

/// Same type and same content; a date equals the text that names the same instant.
fn equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Date(_), Value::Text(_)) | (Value::Text(_), Value::Date(_)) => {
            order(left, right) == Some(std::cmp::Ordering::Equal)
        }
        (Value::List(a), Value::List(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equal(a, b))
        }
        _ => left == right,
    }
}

/// Numbers, texts (an ISO date sorts as one) and dates have an order.
fn order(left: &Value, right: &Value) -> Option<std::cmp::Ordering> {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.partial_cmp(b),
        (Value::Text(a), Value::Text(b)) => Some(a.cmp(b)),
        (Value::Date(a), Value::Date(b)) => Some(a.cmp(b)),
        (Value::Date(a), Value::Text(b)) => Some(a.cmp(&date_millis(b)?)),
        (Value::Text(a), Value::Date(b)) => Some(date_millis(a)?.cmp(b)),
        _ => None,
    }
}

/// `YYYY-MM-DD`, optionally with a time and a zone, as milliseconds; without a zone it is local.
fn date_millis(text: &str) -> Option<i64> {
    let text = text.trim();
    if let Ok(date) = DateTime::parse_from_rfc3339(text) {
        return Some(date.timestamp_millis());
    }
    let local = [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M",
    ]
    .iter()
    .find_map(|format| NaiveDateTime::parse_from_str(text, format).ok())
    .or_else(|| {
        NaiveDate::parse_from_str(text, "%Y-%m-%d")
            .ok()?
            .and_hms_opt(0, 0, 0)
    })?;
    Local
        .from_local_datetime(&local)
        .earliest()
        .map(|d| d.timestamp_millis())
}
