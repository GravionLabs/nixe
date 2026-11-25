//! The functions of the expression language (<https://obsidian.md/help/bases/functions>), which
//! follow JavaScript. A function of a missing value, or with a missing argument, has no value; a
//! value of a type the function does not take is an error.

use std::cmp::Ordering;
use std::collections::HashSet;

use super::date::{Date, Duration, Part};
use super::eval::{bare_target, equal, order, Link, Value};
use super::expr::{Global, Method};
use super::formula::clip;
use crate::vault::resolve::Resolver;

/// Most bytes of text plus items a function or an operator may build.
const MAX_SIZE: usize = 100_000;
/// Most lists and mappings inside each other.
const MAX_NESTING: usize = 50;
/// Most decimal places of `round` and `toFixed`.
const MAX_DIGITS: f64 = 100.0;
/// The size of a date: `YYYY-MM-DD hh:mm:ss`.
const DATE_SIZE: usize = 19;
/// Most bytes of the format of a date; reading it takes quadratic time.
const MAX_FORMAT: usize = 1_000;
/// The schemes of a link to something outside the vault.
const URL_SCHEMES: &[&str] = &["http://", "https://", "mailto:", "tel:"];

fn too_large() -> String {
    "the value is too large".into()
}

/// The size of a value: bytes of text plus items; an error when it is nested too deeply.
pub fn size(value: &Value) -> Result<usize, String> {
    nested_size(value, 0)
}

fn nested_size(value: &Value, depth: usize) -> Result<usize, String> {
    if depth > MAX_NESTING {
        return Err(too_large());
    }
    Ok(match value {
        Value::Text(s) => s.len(),
        Value::List(items) => items.iter().try_fold(0, |sum, item| {
            Ok::<_, String>(sum + 1 + nested_size(item, depth + 1)?)
        })?,
        Value::Object(entries) => entries.iter().try_fold(0, |sum, (key, item)| {
            Ok::<_, String>(sum + key.len() + nested_size(item, depth + 1)?)
        })?,
        Value::Link(link) => link.target.len() + link.display.as_ref().map_or(0, String::len),
        // As long as their texts, which a list or a table repeats.
        Value::Date(_) => DATE_SIZE,
        Value::Duration(duration) => duration.text().len(),
        Value::Null | Value::Bool(_) | Value::Number(_) => 1,
    })
}

/// `value`, unless it grew too large: formulas that use each other could fill the memory.
pub fn bounded(value: Value) -> Result<Value, String> {
    if size(&value)? > MAX_SIZE {
        return Err(too_large());
    }
    Ok(value)
}

/// The list of `items`; it stops as soon as it grows too large.
pub fn list_of(items: impl Iterator<Item = Result<Value, String>>) -> Result<Value, String> {
    let mut list = Vec::new();
    let mut total = 0;
    for item in items {
        let item = item?;
        total += 1 + nested_size(&item, 1)?;
        if total > MAX_SIZE {
            return Err(too_large());
        }
        list.push(item);
    }
    Ok(Value::List(list))
}

/// The name of the type of a value, as `isType` takes it.
fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::Text(_) => "string",
        Value::Date(_) => "date",
        Value::Duration(_) => "duration",
        Value::List(_) => "list",
        Value::Object(_) => "object",
        Value::Link(_) => "link",
    }
}

fn unavailable(name: &str, value: &Value) -> String {
    format!("`{name}` is not available on a {}", type_name(value))
}

/// The text of a value; empty for no value.
pub fn text_of(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        // Without the sign of a negative zero.
        Value::Number(n) => (n + 0.0).to_string(),
        Value::Text(s) => s.clone(),
        Value::Date(date) => date.text().unwrap_or_default(),
        Value::Duration(duration) => duration.text(),
        Value::List(items) => items.iter().map(text_of).collect::<Vec<_>>().join(", "),
        Value::Object(entries) => entries
            .iter()
            .map(|(key, value)| format!("{key}: {}", text_of(value)))
            .collect::<Vec<_>>()
            .join(", "),
        Value::Link(link) => match &link.display {
            Some(display) => format!("[[{}|{display}]]", link.target),
            None => format!("[[{}]]", link.target),
        },
    }
}

/// The global functions but `if` and `link`, which need more than their values.
pub fn global(function: Global, args: Vec<Value>, now: i64) -> Result<Value, String> {
    let mut args = args.into_iter();
    match function {
        Global::List => match args.next().unwrap_or(Value::Null) {
            list @ Value::List(_) => Ok(list),
            Value::Null => Ok(Value::List(Vec::new())),
            other => list_of(std::iter::once(Ok(other))),
        },
        Global::Number => number(args.next().unwrap_or(Value::Null)),
        Global::Date => date(args.next().unwrap_or(Value::Null)),
        Global::Duration => duration(args.next().unwrap_or(Value::Null)),
        Global::Now => Ok(Date::at(now).map_or(Value::Null, Value::Date)),
        Global::Today => Ok(Date::at(now)
            .and_then(Date::day)
            .map_or(Value::Null, Value::Date)),
        Global::Min | Global::Max => {
            let (name, pick): (_, fn(f64, f64) -> f64) = if function == Global::Min {
                ("min", f64::min)
            } else {
                ("max", f64::max)
            };
            let mut numbers = Vec::new();
            for arg in args {
                match arg {
                    Value::Null => return Ok(Value::Null),
                    Value::Number(n) => numbers.push(n),
                    other => {
                        return Err(format!(
                            "`{name}` takes numbers, found a {}",
                            type_name(&other)
                        ))
                    }
                }
            }
            Ok(numbers
                .into_iter()
                .reduce(pick)
                .map_or(Value::Null, Value::Number))
        }
        Global::If | Global::Link => Ok(Value::Null),
    }
}

/// `date(x)`: a text is read, a date stays.
fn date(value: Value) -> Result<Value, String> {
    Ok(match value {
        Value::Null => Value::Null,
        Value::Date(date) => Value::Date(date),
        Value::Text(s) => match Date::parse(&s) {
            Some(date) => Value::Date(date),
            None => return Err(format!("`date` cannot read \"{}\"", clip(&s, 100))),
        },
        other => return Err(unavailable("date", &other)),
    })
}

/// `duration(x)`: a text is read, a duration stays.
fn duration(value: Value) -> Result<Value, String> {
    Ok(match value {
        Value::Null => Value::Null,
        Value::Duration(duration) => Value::Duration(duration),
        Value::Text(s) => match Duration::parse(&s) {
            Some(duration) => Value::Duration(duration),
            None => return Err(format!("`duration` cannot read \"{}\"", clip(&s, 100))),
        },
        other => return Err(unavailable("duration", &other)),
    })
}

/// `number(x)`: booleans are 1 and 0, a date and a duration are milliseconds, a text is read.
fn number(value: Value) -> Result<Value, String> {
    Ok(match value {
        Value::Null => Value::Null,
        Value::Bool(b) => Value::Number(f64::from(u8::from(b))),
        Value::Number(n) => Value::Number(n),
        Value::Date(date) => Value::Number(date.millis as f64),
        Value::Duration(duration) => Value::Number(duration.total()),
        Value::Text(s) => match s.trim().parse::<f64>() {
            Ok(n) if n.is_finite() => Value::Number(n),
            _ => return Err(format!("`number` cannot read \"{}\"", clip(&s, 100))),
        },
        other => return Err(unavailable("number", &other)),
    })
}

/// `link(path, display?)`: a link to a file of the vault or to a URL.
pub fn link(args: &[Value], resolver: &Resolver) -> Result<Value, String> {
    let display = match args.get(1) {
        None | Some(Value::Null) => None,
        Some(value) => Some(text_of(value)),
    };
    let target = match args.first() {
        None | Some(Value::Null) => return Ok(Value::Null),
        Some(Value::Text(s)) => bare_target(s).to_string(),
        Some(Value::Link(link)) => link.target.clone(),
        // The daily note of the date.
        Some(date @ Value::Date(_)) => text_of(date),
        Some(other) => return Err(unavailable("link", other)),
    };
    if target.is_empty() {
        return Ok(Value::Null);
    }
    let lower = target.to_lowercase();
    let url = URL_SCHEMES.iter().any(|scheme| lower.starts_with(scheme));
    let path = if url { None } else { resolver.resolve(&target) };
    bounded(Value::Link(Link {
        target,
        display,
        path,
        url,
    }))
}

/// `.year`, `.month`, …: a field of a date.
pub fn part(value: &Value, part: Part) -> Result<Value, String> {
    match value {
        Value::Null => Ok(Value::Null),
        Value::Date(date) => Ok(date.part(part).map_or(Value::Null, Value::Number)),
        other => Err(unavailable(part.name(), other)),
    }
}

/// `.length`: the characters of a text, the items of a list.
pub fn length(value: &Value) -> Result<Value, String> {
    match value {
        Value::Null => Ok(Value::Null),
        Value::Text(s) => Ok(Value::Number(s.chars().count() as f64)),
        Value::List(items) => Ok(Value::Number(items.len() as f64)),
        other => Err(unavailable("length", other)),
    }
}

/// `receiver.method(args)`; the parser checked the number of arguments.
pub fn method(receiver: Value, method: Method, args: &[Value], now: i64) -> Result<Value, String> {
    match method {
        Method::IsTruthy => Ok(Value::Bool(receiver.is_true())),
        Method::ToString => bounded(Value::Text(text_of(&receiver))),
        Method::IsType => match args.first() {
            Some(Value::Text(wanted)) => Ok(Value::Bool(type_name(&receiver) == wanted)),
            Some(Value::Null) | None => Ok(Value::Null),
            Some(other) => Err(format!(
                "`isType` takes a text, found a {}",
                type_name(other)
            )),
        },
        Method::IsEmpty => match receiver {
            Value::Null => Ok(Value::Bool(true)),
            Value::Text(s) => Ok(Value::Bool(s.is_empty())),
            Value::Number(_) | Value::Date(_) => Ok(Value::Bool(false)),
            Value::List(items) => Ok(Value::Bool(items.is_empty())),
            other => Err(unavailable("isEmpty", &other)),
        },
        Method::Abs | Method::Ceil | Method::Floor | Method::Round | Method::ToFixed => {
            number_method(receiver, method, args)
        }
        Method::Contains
        | Method::ContainsAll
        | Method::ContainsAny
        | Method::StartsWith
        | Method::EndsWith
        | Method::Lower
        | Method::Title
        | Method::Trim
        | Method::Replace
        | Method::Slice
        | Method::Split
        | Method::Repeat
        | Method::Reverse => match receiver {
            Value::List(items) => list_method(items, method, args),
            other => string_method(other, method, args),
        },
        Method::Join | Method::Flat | Method::Unique | Method::Sort => match receiver {
            Value::Null => Ok(Value::Null),
            Value::List(items) => list_method(items, method, args),
            other => Err(unavailable(name_of(method), &other)),
        },
        Method::Format | Method::Date | Method::Time | Method::Relative => {
            date_method(receiver, method, args, now)
        }
    }
}

fn date_method(receiver: Value, method: Method, args: &[Value], now: i64) -> Result<Value, String> {
    let date = match receiver {
        Value::Null => return Ok(Value::Null),
        Value::Date(date) => date,
        other => return Err(unavailable(name_of(method), &other)),
    };
    let text = |text: Option<String>| text.map_or(Value::Null, Value::Text);
    bounded(match method {
        Method::Date => date.day().map_or(Value::Null, Value::Date),
        Method::Time => text(date.time()),
        Method::Relative => Value::Text(date.relative(now)),
        _ => match args.first() {
            None | Some(Value::Null) => Value::Null,
            Some(Value::Text(format)) if format.len() > MAX_FORMAT => {
                return Err("the format is too long".into())
            }
            Some(Value::Text(format)) => text(date.format(format)),
            Some(other) => {
                return Err(format!(
                    "`format` takes a text, found a {}",
                    type_name(other)
                ))
            }
        },
    })
}

/// The functions of a list; `method` is one of them.
fn list_method(mut items: Vec<Value>, method: Method, args: &[Value]) -> Result<Value, String> {
    // `slice` may leave out its last argument.
    let needed = match method {
        Method::Slice => &args[..args.len().min(1)],
        _ => args,
    };
    if needed.contains(&Value::Null) {
        return Ok(Value::Null);
    }
    let has = |wanted: &Value| items.iter().any(|item| equal(item, wanted));
    let result = match method {
        Method::Contains | Method::ContainsAll => Value::Bool(args.iter().all(has)),
        Method::ContainsAny => Value::Bool(args.iter().any(has)),
        Method::Join => {
            let separator = match args.first() {
                Some(Value::Text(s)) => s,
                Some(other) => {
                    return Err(format!("`join` takes a text, found a {}", type_name(other)))
                }
                None => return Ok(Value::Null),
            };
            // Checked while the text is built.
            let mut text = String::new();
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    text.push_str(separator);
                }
                text.push_str(&text_of(item));
                if text.len() > MAX_SIZE {
                    return Err(too_large());
                }
            }
            Value::Text(text)
        }
        // One level, as in JavaScript.
        Method::Flat => {
            return list_of(
                items
                    .into_iter()
                    .flat_map(|item| match item {
                        Value::List(inner) => inner,
                        other => vec![other],
                    })
                    .map(Ok),
            )
        }
        Method::Unique => {
            let mut seen = HashSet::new();
            items.retain(|item| seen.insert(identity(item)));
            Value::List(items)
        }
        Method::Sort => {
            items.sort_by(ascending);
            Value::List(items)
        }
        Method::Reverse => {
            items.reverse();
            Value::List(items)
        }
        Method::Slice => {
            let (start, end) = range(method, args, items.len())?;
            Value::List(items.drain(start..end).collect())
        }
        _ => return Err(unavailable(name_of(method), &Value::List(items))),
    };
    bounded(result)
}

/// What two items that are the same have in common: `unique` keeps the first of them.
fn identity(value: &Value) -> String {
    match value {
        Value::Date(date) => format!("date {}", date.millis),
        Value::Duration(duration) => format!("duration {}", duration.total()),
        Value::Link(link) => match &link.path {
            Some(path) => format!("file {path:?}"),
            None => format!("link {:?}", link.target.to_lowercase()),
        },
        Value::List(items) => {
            let items: Vec<String> = items.iter().map(identity).collect();
            format!("list [{}]", items.join(","))
        }
        Value::Number(n) => format!("number {}", n + 0.0),
        other => format!("{other:?}"),
    }
}

/// The order of `sort`: smallest first. Different types are grouped (booleans, numbers, dates,
/// durations, texts, links, the rest, missing values); what has no order keeps its place.
fn ascending(a: &Value, b: &Value) -> Ordering {
    let rank = |value: &Value| match value {
        Value::Bool(_) => 0,
        Value::Number(_) => 1,
        Value::Date(_) => 2,
        Value::Duration(_) => 3,
        Value::Text(_) => 4,
        Value::Link(_) => 5,
        Value::List(_) | Value::Object(_) => 6,
        Value::Null => 7,
    };
    rank(a).cmp(&rank(b)).then_with(|| match (a, b) {
        (Value::Bool(a), Value::Bool(b)) => a.cmp(b),
        (Value::Number(a), Value::Number(b)) => a.total_cmp(b),
        (Value::Duration(a), Value::Duration(b)) => a.total().total_cmp(&b.total()),
        (Value::Link(a), Value::Link(b)) => a.text().cmp(b.text()),
        _ => order(a, b).unwrap_or(Ordering::Equal),
    })
}

/// The start and end of `slice` in a value of `length` parts; a negative position counts from the
/// end, and the end is never before the start.
fn range(method: Method, args: &[Value], length: usize) -> Result<(usize, usize), String> {
    let position = |value: &Value| -> Result<usize, String> {
        let n = whole(method, value)?;
        let n = if n < 0.0 { length as f64 + n } else { n };
        Ok(n.clamp(0.0, length as f64) as usize)
    };
    let start = args.first().map_or(Ok(0), position)?;
    let end = args
        .get(1)
        .filter(|a| **a != Value::Null)
        .map_or(Ok(length), position)?;
    Ok((start, end.max(start)))
}

/// The name of a method as it is written.
fn name_of(method: Method) -> &'static str {
    match method {
        Method::IsTruthy => "isTruthy",
        Method::IsType => "isType",
        Method::ToString => "toString",
        Method::IsEmpty => "isEmpty",
        Method::Contains => "contains",
        Method::ContainsAll => "containsAll",
        Method::ContainsAny => "containsAny",
        Method::StartsWith => "startsWith",
        Method::EndsWith => "endsWith",
        Method::Lower => "lower",
        Method::Title => "title",
        Method::Trim => "trim",
        Method::Replace => "replace",
        Method::Slice => "slice",
        Method::Split => "split",
        Method::Repeat => "repeat",
        Method::Reverse => "reverse",
        Method::Join => "join",
        Method::Flat => "flat",
        Method::Unique => "unique",
        Method::Sort => "sort",
        Method::Format => "format",
        Method::Date => "date",
        Method::Time => "time",
        Method::Relative => "relative",
        Method::Abs => "abs",
        Method::Ceil => "ceil",
        Method::Floor => "floor",
        Method::Round => "round",
        Method::ToFixed => "toFixed",
    }
}

/// An argument that has to be a whole number; a fraction is cut off.
fn whole(method: Method, value: &Value) -> Result<f64, String> {
    match value {
        Value::Number(n) => Ok(n.trunc()),
        other => Err(format!(
            "`{}` takes a number, found a {}",
            name_of(method),
            type_name(other)
        )),
    }
}

/// A count of digits from 0 to `MAX_DIGITS`.
fn digits(method: Method, value: &Value) -> Result<usize, String> {
    let n = whole(method, value)?;
    if !(0.0..=MAX_DIGITS).contains(&n) {
        return Err(format!(
            "`{}` takes 0 to {MAX_DIGITS} digits",
            name_of(method)
        ));
    }
    Ok(n as usize)
}

fn number_method(receiver: Value, method: Method, args: &[Value]) -> Result<Value, String> {
    let n = match receiver {
        Value::Null => return Ok(Value::Null),
        Value::Number(n) => n,
        other => return Err(unavailable(name_of(method), &other)),
    };
    Ok(match method {
        Method::Abs => Value::Number(n.abs()),
        Method::Ceil => Value::Number(n.ceil()),
        Method::Floor => Value::Number(n.floor()),
        Method::Round => {
            let places = match args.first() {
                None | Some(Value::Null) => 0,
                Some(value) => digits(method, value)?,
            };
            Value::Number(round(n, places))
        }
        _ => match args.first() {
            None | Some(Value::Null) => Value::Null,
            Some(value) => Value::Text(to_fixed(n, digits(method, value)?)),
        },
    })
}

/// Rounds to `places` decimal places; a half goes up, as in JavaScript.
fn round(n: f64, places: usize) -> f64 {
    let factor = 10f64.powi(places as i32);
    let scaled = n * factor;
    // So large a number has no such places.
    if !scaled.is_finite() {
        return n;
    }
    let below = scaled.floor();
    let rounded = if scaled - below >= 0.5 {
        below + 1.0
    } else {
        below
    };
    rounded / factor
}

/// `n` with `places` decimal places; a half goes away from zero, as in JavaScript.
fn to_fixed(n: f64, places: usize) -> String {
    let n = n + 0.0;
    // Every digit of a double is within 1074 places; Rust rounds a half to even.
    let exact = format!("{:.1074}", n.abs());
    let half = exact.find('.').is_some_and(|point| {
        let rest = &exact[point + 1 + places..];
        rest.strip_prefix('5')
            .is_some_and(|zeros| zeros.bytes().all(|b| b == b'0'))
    });
    // The next double away from zero is above the half.
    let n = if half {
        f64::from_bits(n.to_bits() + 1)
    } else {
        n
    };
    format!("{n:.places$}")
}

fn string_method(receiver: Value, method: Method, args: &[Value]) -> Result<Value, String> {
    let text = match receiver {
        Value::Null => return Ok(Value::Null),
        Value::Text(s) => s,
        other => return Err(unavailable(name_of(method), &other)),
    };
    // `slice` and `split` may leave out their last argument.
    let needed = match method {
        Method::Slice | Method::Split => &args[..args.len().min(1)],
        _ => args,
    };
    if needed.contains(&Value::Null) {
        return Ok(Value::Null);
    }
    let texts = || -> Result<Vec<&str>, String> {
        needed
            .iter()
            .map(|arg| match arg {
                Value::Text(s) => Ok(s.as_str()),
                other => Err(format!(
                    "`{}` takes a text, found a {}",
                    name_of(method),
                    type_name(other)
                )),
            })
            .collect()
    };
    let first = || texts().map(|t| t.first().copied().unwrap_or_default());
    let optional = || args.get(1).filter(|a| **a != Value::Null);
    let result = match method {
        Method::Contains => Value::Bool(text.contains(first()?)),
        Method::ContainsAll => Value::Bool(texts()?.iter().all(|t| text.contains(t))),
        Method::ContainsAny => Value::Bool(texts()?.iter().any(|t| text.contains(t))),
        Method::StartsWith => Value::Bool(text.starts_with(first()?)),
        Method::EndsWith => Value::Bool(text.ends_with(first()?)),
        Method::Lower => Value::Text(text.to_lowercase()),
        Method::Title => Value::Text(title(&text)),
        Method::Trim => Value::Text(text.trim().to_string()),
        Method::Reverse => Value::Text(text.chars().rev().collect()),
        Method::Replace => {
            let texts = texts()?;
            let [from, to] = texts[..] else {
                return Ok(Value::Null);
            };
            // Checked before the text is built.
            let found = text.matches(from).count();
            let grown = found.saturating_mul(to.len().saturating_sub(from.len()));
            if text.len().saturating_add(grown) > MAX_SIZE {
                return Err(too_large());
            }
            Value::Text(text.replace(from, to))
        }
        Method::Repeat => {
            let count = match args.first() {
                Some(value) => whole(method, value)?,
                None => 0.0,
            };
            if count < 0.0 {
                return Err("`repeat` takes a count of 0 or more".into());
            }
            if text.is_empty() {
                Value::Text(text)
            } else if count * text.len() as f64 > MAX_SIZE as f64 {
                return Err(too_large());
            } else {
                Value::Text(text.repeat(count as usize))
            }
        }
        Method::Slice => {
            let (start, end) = range(method, args, text.chars().count())?;
            Value::Text(text.chars().skip(start).take(end - start).collect())
        }
        Method::Split => {
            let separator = first()?;
            let limit = match optional() {
                Some(value) => whole(method, value)?,
                None => f64::INFINITY,
            };
            if limit < 0.0 {
                return Err("`split` takes a limit of 0 or more".into());
            }
            // A float beyond the range becomes the largest number.
            let limit = limit as usize;
            let part = |s: &str| Ok(Value::Text(s.to_string()));
            return if separator.is_empty() {
                // Every character on its own.
                list_of(
                    text.chars()
                        .take(limit)
                        .map(|c| Ok(Value::Text(c.to_string()))),
                )
            } else {
                list_of(text.split(separator).take(limit).map(part))
            };
        }
        _ => Value::Null,
    };
    bounded(result)
}

/// Every word with a capital first letter and the rest in lower case.
fn title(text: &str) -> String {
    let mut start = true;
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if start {
            out.extend(c.to_uppercase());
        } else {
            out.extend(c.to_lowercase());
        }
        start = c.is_whitespace();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn halves_round_as_in_javascript() {
        for (n, places, wanted) in [
            (2.5, 0, 3.0),
            (-2.5, 0, -2.0),
            (2.3333, 2, 2.33),
            (-2.7, 0, -3.0),
            (0.499_999_999_999_999_94, 0, 0.0),
            (1e300, 100, 1e300),
        ] {
            assert_eq!(round(n, places), wanted, "{n}");
        }
        for (n, places, wanted) in [
            (1.23456, 2, "1.23"),
            (2.5, 0, "3"),
            (-2.5, 0, "-3"),
            (1.25, 1, "1.3"),
            // The double is below the half.
            (1.005, 2, "1.00"),
            (5.0, 2, "5.00"),
            (-0.0, 1, "0.0"),
        ] {
            assert_eq!(to_fixed(n, places), wanted, "{n}");
        }
    }
}
