//! Evaluation of expressions, formulas and filters on the notes of the index. A note that lacks a
//! property is never an error: the operation or function has no value, which is false. An operator
//! on a value of another type has no value either; a function on one is an error (`functions`).

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use serde_json::Value as Json;

use super::date::{Date, Duration};
use super::expr::{Expr, Field, Function, Global, Op};
use super::formula::Formulas;
use super::functions;

/// Most size of the values of all formulas of one note, which are kept while its row is built.
const MAX_NOTE_SIZE: usize = 1_000_000;
use crate::index::read::{IndexedProperty, NoteFile};
use crate::vault::resolve::{parse_target, Resolver};

/// A value of the language.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    Text(String),
    Date(Date),
    Duration(Duration),
    List(Vec<Value>),
    /// `file.properties` and mappings in the frontmatter.
    Object(Vec<(String, Value)>),
    Link(Link),
}

/// What `link()` makes.
#[derive(Debug, Clone, PartialEq)]
pub struct Link {
    /// The target as written, without `[[…]]`; a URL for a web link.
    pub target: String,
    pub display: Option<String>,
    /// The file of the vault the target names.
    pub path: Option<String>,
    /// True for a web, mail or phone address.
    pub url: bool,
}

impl Link {
    /// The text the link shows.
    pub fn text(&self) -> &str {
        self.display.as_deref().unwrap_or(&self.target)
    }
}

impl Value {
    /// False for no value, `false`, `0` and an empty text, list or mapping.
    pub fn is_true(&self) -> bool {
        match self {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::Number(n) => *n != 0.0 && !n.is_nan(),
            Value::Text(s) => !s.is_empty(),
            Value::Date(_) | Value::Duration(_) | Value::Link(_) => true,
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
    /// An expression, and its source for messages.
    Expr(Expr, String),
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
    resolver: &'a Resolver,
    formulas: &'a Formulas,
    /// The current time, in milliseconds since the Unix epoch.
    now: i64,
    /// The formulas evaluated on this note so far, by index.
    values: RefCell<HashMap<usize, Result<Value, String>>>,
    /// The size of those values.
    kept: Cell<usize>,
}

/// Why a filter could not be applied to a note.
#[derive(Debug, PartialEq)]
pub struct FilterError {
    pub message: String,
    /// The expression that failed.
    pub source: String,
}

impl<'a> Context<'a> {
    pub fn new(
        note: &'a NoteFile,
        resolver: &'a Resolver,
        formulas: &'a Formulas,
        now: i64,
    ) -> Self {
        Context {
            note,
            resolver,
            formulas,
            now,
            values: RefCell::default(),
            kept: Cell::new(0),
        }
    }

    pub fn matches(&self, filter: &Filter) -> Result<bool, FilterError> {
        // The first entry that decides ends the group.
        let any = |filters: &[Filter], wanted: bool| {
            for f in filters {
                if self.matches(f)? == wanted {
                    return Ok(true);
                }
            }
            Ok(false)
        };
        Ok(match filter {
            Filter::Expr(expr, source) => self
                .eval(expr)
                .map_err(|message| FilterError {
                    message,
                    source: source.clone(),
                })?
                .is_true(),
            Filter::And(all) => !any(all, false)?,
            // A group without entries sets no condition.
            Filter::Or(entries) => entries.is_empty() || any(entries, true)?,
            Filter::Not(none) => !any(none, true)?,
        })
    }

    /// The value of the formula `name`. The formulas it refers to are evaluated first, one after the
    /// other, so a long chain of formulas needs no deep recursion.
    pub fn formula(&self, name: &str) -> Result<Value, String> {
        let wanted = self.formulas.index(name)?;
        let mut pending = vec![wanted];
        while let Some(&index) = pending.last() {
            if self.values.borrow().contains_key(&index) {
                pending.pop();
                continue;
            }
            let value = match self.formulas.get(index) {
                Ok(formula) => {
                    let known = self.values.borrow();
                    let before = pending.len();
                    pending.extend(formula.refs.iter().filter(|i| !known.contains_key(i)));
                    drop(known);
                    if pending.len() > before {
                        continue;
                    }
                    self.keep(&formula.expr)
                }
                Err(error) => Err(error.to_string()),
            };
            self.values.borrow_mut().insert(index, value);
            pending.pop();
        }
        self.values
            .borrow()
            .get(&wanted)
            .cloned()
            .unwrap_or(Ok(Value::Null))
    }

    /// The value of a formula that will be kept; an error when the note would hold too much.
    fn keep(&self, expr: &Expr) -> Result<Value, String> {
        let value = self.eval(expr)?;
        let kept = self.kept.get().saturating_add(functions::size(&value)?);
        if kept > MAX_NOTE_SIZE {
            return Err("the formulas of this note are too large".into());
        }
        self.kept.set(kept);
        Ok(value)
    }

    pub fn eval(&self, expr: &Expr) -> Result<Value, String> {
        let all = |exprs: &[Expr]| -> Result<Vec<Value>, String> {
            exprs.iter().map(|e| self.eval(e)).collect()
        };
        Ok(match expr {
            Expr::Text(s) => Value::Text(s.clone()),
            Expr::Number(n) => Value::Number(*n),
            Expr::Bool(b) => Value::Bool(*b),
            Expr::List(items) => functions::list_of(items.iter().map(|item| self.eval(item)))?,
            Expr::Property(name) => self.property(name).map_or(Value::Null, property_value),
            Expr::File(field) => self.field(*field),
            Expr::Formula(name) => self.formula(name)?,
            Expr::Call(function, args) => Value::Bool(self.call(*function, &all(args)?)),
            // Only the chosen branch is evaluated.
            Expr::Global(Global::If, args) => {
                let condition = args.first().map(|c| self.eval(c)).transpose()?;
                let branch = if condition.is_some_and(|c| c.is_true()) {
                    1
                } else {
                    2
                };
                args.get(branch).map_or(Ok(Value::Null), |b| self.eval(b))?
            }
            Expr::Global(Global::Link, args) => functions::link(&all(args)?, self.resolver)?,
            Expr::Global(function, args) => functions::global(*function, all(args)?, self.now)?,
            Expr::Method(receiver, method, args) => {
                functions::method(self.eval(receiver)?, *method, &all(args)?, self.now)?
            }
            Expr::Length(inner) => functions::length(&self.eval(inner)?)?,
            Expr::Part(inner, part) => functions::part(&self.eval(inner)?, *part)?,
            Expr::Not(inner) => Value::Bool(!self.eval(inner)?.is_true()),
            Expr::Negate(inner) => match self.eval(inner)? {
                Value::Number(n) => Value::Number(-n),
                _ => Value::Null,
            },
            Expr::Binary(op, left, right) => {
                let left = self.eval(left)?;
                match op {
                    Op::And => Value::Bool(left.is_true() && self.eval(right)?.is_true()),
                    Op::Or => Value::Bool(left.is_true() || self.eval(right)?.is_true()),
                    _ => functions::bounded(binary(*op, &left, &self.eval(right)?))?,
                }
            }
        })
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
            Field::Ctime => time_of(note.ctime_ns),
            Field::Mtime => time_of(note.mtime_ns),
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
                Value::List(items) => texts.extend(items.iter().filter_map(name_of)),
                other => texts.extend(name_of(other)),
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
        let target = bare_target(target);
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

/// The value of a note property: a date or a date with a time is a date.
fn property_value(property: &IndexedProperty) -> Value {
    if property.kind == "date" {
        if let Some(date) = property.value.as_str().and_then(Date::parse) {
            return Value::Date(date);
        }
    }
    Value::from_json(&property.value)
}

/// A file time in nanoseconds as a date.
fn time_of(nanos: i64) -> Value {
    Date::at(nanos.div_euclid(1_000_000)).map_or(Value::Null, Value::Date)
}

/// The text a file function takes from an argument: a text, or the target of a link.
fn name_of(value: &Value) -> Option<&str> {
    match value {
        Value::Text(s) => Some(s),
        Value::Link(link) => Some(&link.target),
        _ => None,
    }
}

/// The target of a link written as a path, a name, `[[…]]` or `![[…]]`.
pub fn bare_target(target: &str) -> &str {
    let target = target.trim();
    let target = target.strip_prefix('!').unwrap_or(target);
    target
        .strip_prefix("[[")
        .and_then(|t| t.strip_suffix("]]"))
        .map_or(target, |t| t.split('|').next().unwrap_or(t))
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
        Op::Add | Op::Sub | Op::Mul | Op::Div | Op::Rem => arithmetic(op, left, right),
        Op::And | Op::Or => Value::Null,
    }
}

/// A duration, also one written as a text.
fn duration_of(value: &Value) -> Option<Duration> {
    match value {
        Value::Duration(duration) => Some(*duration),
        Value::Text(s) => Duration::parse(s),
        _ => None,
    }
}

/// `+ - * / %`: on numbers, texts, and on dates and durations, which stand on the left.
fn arithmetic(op: Op, left: &Value, right: &Value) -> Value {
    let date = |d: Option<Date>| d.map_or(Value::Null, Value::Date);
    let duration = |d: Option<Duration>| d.map_or(Value::Null, Value::Duration);
    match (op, left, right) {
        (Op::Add, Value::Number(a), Value::Number(b)) => Value::Number(a + b),
        (Op::Add, Value::Text(a), Value::Text(b)) => Value::Text(format!("{a}{b}")),
        (Op::Add, Value::Text(a), Value::Number(b)) => Value::Text(format!("{a}{b}")),
        (Op::Add, Value::Number(a), Value::Text(b)) => Value::Text(format!("{a}{b}")),
        (Op::Add, Value::Text(a), Value::Date(_) | Value::Duration(_)) => {
            Value::Text(format!("{a}{}", functions::text_of(right)))
        }
        (Op::Add, Value::Date(a), _) => date(duration_of(right).and_then(|b| a.plus(b))),
        (Op::Sub, Value::Date(a), Value::Date(b)) => Value::Duration(Duration::between(*b, *a)),
        (Op::Sub, Value::Date(a), _) => date(duration_of(right).and_then(|b| a.plus(b.negated()))),
        (Op::Add, Value::Duration(a), _) => duration(duration_of(right).and_then(|b| a.plus(b))),
        (Op::Sub, Value::Duration(a), _) => {
            duration(duration_of(right).and_then(|b| a.plus(b.negated())))
        }
        (Op::Mul, Value::Duration(a), Value::Number(b)) => duration(a.times(*b)),
        (Op::Div, Value::Duration(a), Value::Number(b)) => duration(a.times(b.recip())),
        (_, Value::Number(a), Value::Number(b)) => {
            let result = match op {
                Op::Sub => a - b,
                Op::Mul => a * b,
                Op::Div => a / b,
                Op::Rem => a % b,
                _ => return Value::Null,
            };
            // A division by zero has no value.
            if result.is_finite() {
                Value::Number(result)
            } else {
                Value::Null
            }
        }
        _ => Value::Null,
    }
}

/// Same type and same content; a date equals the text that names the same instant, a duration the
/// text of one of the same length.
pub fn equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Date(_), Value::Date(_) | Value::Text(_))
        | (Value::Text(_), Value::Date(_))
        | (Value::Duration(_), Value::Duration(_) | Value::Text(_))
        | (Value::Text(_), Value::Duration(_)) => {
            order(left, right) == Some(std::cmp::Ordering::Equal)
        }
        (Value::List(a), Value::List(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equal(a, b))
        }
        // Two links are the same file, or, where there is none, the same text.
        (Value::Link(a), Value::Link(b)) => match (&a.path, &b.path) {
            (None, None) => a.target.to_lowercase() == b.target.to_lowercase(),
            (a, b) => a == b,
        },
        _ => left == right,
    }
}

/// Numbers, texts, dates and durations have an order.
pub fn order(left: &Value, right: &Value) -> Option<std::cmp::Ordering> {
    let millis = |text: &str| Date::parse(text).map(|d| d.millis);
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.partial_cmp(b),
        (Value::Text(a), Value::Text(b)) => Some(a.cmp(b)),
        (Value::Date(a), Value::Date(b)) => Some(a.millis.cmp(&b.millis)),
        (Value::Date(a), Value::Text(b)) => Some(a.millis.cmp(&millis(b)?)),
        (Value::Text(a), Value::Date(b)) => Some(millis(a)?.cmp(&b.millis)),
        (Value::Duration(a), _) => a.order(duration_of(right)?),
        (Value::Text(_), Value::Duration(b)) => duration_of(left)?.order(*b),
        _ => None,
    }
}
