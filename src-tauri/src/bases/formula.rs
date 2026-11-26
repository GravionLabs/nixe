//! The `formulas` of a base: every one is parsed once, and its references to other formulas are
//! checked. A formula that cannot be evaluated (a syntax error, an unknown formula, a cycle, or a
//! reference to such a formula) holds the message instead; it counts only where it is used.

use std::collections::HashMap;
use std::rc::Rc;

use super::expr::{self, Expr};

/// Most characters of a message; it can quote a whole file, and every cell may repeat it.
const MAX_MESSAGE: usize = 300;
/// Most formulas and characters of a name that the message of a cycle names.
const MAX_CYCLE_NAMES: usize = 8;
const MAX_NAME: usize = 40;

/// `text`, cut after `max` characters.
pub fn clip(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_string(),
    }
}

/// Why a formula cannot be evaluated; the formulas that use it share the message.
type Broken = Option<Rc<str>>;

fn broken(message: &str) -> Rc<str> {
    clip(message, MAX_MESSAGE).into()
}

/// A formula that can be evaluated.
#[derive(Debug)]
pub struct Formula {
    pub expr: Expr,
    /// The formulas the expression refers to, by index; they never lead back to this one.
    pub refs: Vec<usize>,
}

/// The compiled formulas of a base.
#[derive(Debug, Default)]
pub struct Formulas {
    indexes: HashMap<String, usize>,
    list: Vec<Result<Formula, Rc<str>>>,
}

impl Formulas {
    /// Compiles the formulas `(name, expression)`; `None` is an entry that is not a text.
    pub fn compile(sources: &[(String, Option<String>)]) -> Formulas {
        let indexes: HashMap<String, usize> = sources
            .iter()
            .enumerate()
            .map(|(index, (name, _))| (name.clone(), index))
            .collect();
        let mut errors: Vec<Broken> = vec![None; sources.len()];
        let exprs: Vec<Option<Expr>> = sources
            .iter()
            .zip(&mut errors)
            .map(|((name, source), error)| {
                let parsed = match source {
                    Some(source) => expr::parse(source).map_err(|e| format!("{e} in `{source}`")),
                    None => Err("the expression must be a text".into()),
                };
                parsed
                    .map_err(|e| *error = Some(broken(&format!("formula `{name}`: {e}"))))
                    .ok()
            })
            .collect();
        let refs: Vec<Vec<usize>> = exprs
            .iter()
            .zip(sources)
            .zip(&mut errors)
            .map(|((expr, (name, _)), error)| {
                let mut names = Vec::new();
                if let Some(expr) = expr {
                    expr.formulas(&mut names);
                }
                names
                    .into_iter()
                    .filter_map(|wanted| {
                        let index = indexes.get(wanted).copied();
                        if index.is_none() {
                            error.get_or_insert_with(|| {
                                broken(&format!("formula `{name}`: unknown formula `{wanted}`"))
                            });
                        }
                        index
                    })
                    .collect()
            })
            .collect();
        spread_errors(sources, &refs, &mut errors);
        let list = exprs
            .into_iter()
            .zip(refs)
            .zip(errors)
            .map(|((expr, refs), error)| match (expr, error) {
                (Some(expr), None) => Ok(Formula { expr, refs }),
                (_, error) => Err(error.unwrap_or_else(|| "unknown formula".into())),
            })
            .collect();
        Formulas { indexes, list }
    }

    /// The index of the formula `name`.
    pub fn index(&self, name: &str) -> Result<usize, String> {
        self.indexes
            .get(name)
            .copied()
            .ok_or_else(|| format!("unknown formula `{}`", clip(name, MAX_NAME)))
    }

    /// The formula of `index`, or why it cannot be evaluated.
    pub fn get(&self, index: usize) -> Result<&Formula, &str> {
        match self.list.get(index) {
            Some(Ok(formula)) => Ok(formula),
            Some(Err(error)) => Err(error),
            None => Err("unknown formula"),
        }
    }

    /// The error of the first formula `expr` refers to that cannot be evaluated.
    pub fn check(&self, expr: &Expr) -> Result<(), String> {
        let mut names = Vec::new();
        expr.formulas(&mut names);
        for name in names {
            self.get(self.index(name)?)?;
        }
        Ok(())
    }
}

/// Gives every formula of a cycle the message that names it, and every formula that refers to a
/// broken one the message of that one. A depth-first walk without recursion, in linear time.
fn spread_errors(sources: &[(String, Option<String>)], refs: &[Vec<usize>], errors: &mut [Broken]) {
    #[derive(Clone, Copy, PartialEq)]
    enum State {
        New,
        /// On the path, at this position.
        Open(usize),
        Done,
    }
    let mut states = vec![State::New; refs.len()];
    for root in 0..refs.len() {
        if states[root] != State::New {
            continue;
        }
        states[root] = State::Open(0);
        // The path from the root: a formula and the number of its references that were followed.
        let mut path = vec![(root, 0)];
        // The positions of the path that no cycle has marked yet, in order.
        let mut unmarked = vec![0];
        while let Some(&(index, followed)) = path.last() {
            let top = path.len() - 1;
            let Some(&next) = refs[index].get(followed) else {
                states[index] = State::Done;
                path.pop();
                if unmarked.last() == Some(&top) {
                    unmarked.pop();
                }
                if let (Some(error), Some(&(parent, _))) = (&errors[index], path.last()) {
                    let error = Rc::clone(error);
                    errors[parent].get_or_insert(error);
                }
                continue;
            };
            path[top].1 += 1;
            match states[next] {
                State::New => {
                    states[next] = State::Open(path.len());
                    unmarked.push(path.len());
                    path.push((next, 0));
                }
                State::Open(start) => {
                    let mut message: Broken = None;
                    while let Some(&position) = unmarked.last().filter(|&&p| p >= start) {
                        unmarked.pop();
                        let message = message.get_or_insert_with(|| cycle(sources, &path[start..]));
                        errors[path[position].0].get_or_insert_with(|| Rc::clone(message));
                    }
                }
                State::Done => {
                    if let Some(error) = &errors[next] {
                        let error = Rc::clone(error);
                        errors[index].get_or_insert(error);
                    }
                }
            }
        }
    }
}

/// The message of the cycle of the formulas of `path`, whose last one refers to the first; a long
/// cycle is shortened in the middle.
fn cycle(sources: &[(String, Option<String>)], path: &[(usize, usize)]) -> Rc<str> {
    let name = |&(i, _): &(usize, usize)| format!("`{}`", clip(&sources[i].0, MAX_NAME));
    let mut names: Vec<String> = if path.len() > MAX_CYCLE_NAMES {
        let head = path[..MAX_CYCLE_NAMES - 1].iter().map(name);
        head.chain(["…".to_string()])
            .chain(path.last().map(name))
            .collect()
    } else {
        path.iter().map(name).collect()
    };
    names.extend(path.first().map(name));
    format!("the formulas form a cycle: {}", names.join(" → ")).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compile(formulas: &[(&str, &str)]) -> Formulas {
        let sources: Vec<(String, Option<String>)> = formulas
            .iter()
            .map(|(n, s)| (n.to_string(), Some(s.to_string())))
            .collect();
        Formulas::compile(&sources)
    }

    fn error(formulas: &Formulas, name: &str) -> Option<String> {
        formulas
            .get(formulas.index(name).unwrap())
            .err()
            .map(str::to_string)
    }

    #[test]
    fn references_in_any_order_are_no_cycle() {
        let formulas = compile(&[
            ("a", "formula.b + formula.c"),
            ("b", "formula.c"),
            ("c", "1"),
        ]);
        for name in ["a", "b", "c"] {
            assert_eq!(error(&formulas, name), None);
        }
    }

    #[test]
    fn a_cycle_breaks_its_formulas_and_those_that_use_them() {
        let formulas = compile(&[
            ("user", "formula.a"),
            ("a", "formula.b + 1"),
            ("b", "if(false, formula.a)"),
            ("late", "formula.b"),
            ("me", "formula.me"),
            ("fine", "2"),
        ]);
        let cycle = "the formulas form a cycle: `a` → `b` → `a`";
        for name in ["user", "a", "b", "late"] {
            assert_eq!(error(&formulas, name).as_deref(), Some(cycle), "{name}");
        }
        assert_eq!(
            error(&formulas, "me").as_deref(),
            Some("the formulas form a cycle: `me` → `me`")
        );
        assert_eq!(error(&formulas, "fine"), None);
    }

    #[test]
    fn syntax_errors_and_unknown_formulas_spread_to_their_users() {
        let mut sources = vec![
            ("user".to_string(), Some("formula.broken".to_string())),
            ("broken".to_string(), Some("1 +".to_string())),
            ("lost".to_string(), Some("formula.nope".to_string())),
            ("list".to_string(), None),
        ];
        let formulas = Formulas::compile(&sources);
        let broken = "formula `broken`: syntax error: unexpected end in `1 +`";
        assert_eq!(error(&formulas, "broken").as_deref(), Some(broken));
        assert_eq!(error(&formulas, "user").as_deref(), Some(broken));
        assert_eq!(
            error(&formulas, "lost").as_deref(),
            Some("formula `lost`: unknown formula `nope`")
        );
        assert_eq!(
            error(&formulas, "list").as_deref(),
            Some("formula `list`: the expression must be a text")
        );
        assert_eq!(
            formulas.index("nope").unwrap_err(),
            "unknown formula `nope`"
        );
        sources.clear();
        assert!(Formulas::compile(&sources).index("user").is_err());
    }

    #[test]
    fn a_very_long_chain_compiles() {
        let mut sources: Vec<(String, Option<String>)> = (0..20_000)
            .map(|i| (format!("f{i}"), Some(format!("formula.f{}", i + 1))))
            .collect();
        sources.push(("f20000".into(), Some("formula.f0".into())));
        let formulas = Formulas::compile(&sources);
        assert_eq!(
            error(&formulas, "f20000").as_deref(),
            Some(
                "the formulas form a cycle: `f0` → `f1` → `f2` → `f3` → `f4` → `f5` → `f6` → … \
                 → `f20000` → `f0`"
            )
        );
    }

    #[test]
    fn many_cycles_through_one_chain_mark_every_formula() {
        let mut sources: Vec<(String, Option<String>)> = (0..20_000)
            .map(|i| {
                (
                    format!("f{i}"),
                    Some(format!("formula.f{} + formula.f0", i + 1)),
                )
            })
            .collect();
        sources.push(("f20000".into(), Some("formula.f0".into())));
        let formulas = Formulas::compile(&sources);
        for name in ["f0", "f1", "f19999", "f20000"] {
            assert!(error(&formulas, name).unwrap().contains("cycle"), "{name}");
        }
    }

    #[test]
    fn a_message_that_quotes_a_long_source_is_cut() {
        let long = "x".repeat(100_000);
        let formulas = compile(&[("bad", &format!("1 + + '{long}")), ("user", "formula.bad")]);
        let message = error(&formulas, "user").unwrap();
        assert_eq!(message.chars().count(), MAX_MESSAGE + 1);
        assert!(message.ends_with('…'), "{message}");
    }
}
