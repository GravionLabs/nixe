//! The `formulas` of a base: every one is parsed once, and its references to other formulas are
//! checked. A formula that cannot be evaluated (a syntax error, an unknown formula, a cycle, or a
//! reference to such a formula) holds the message instead; it counts only where it is used.

use std::collections::HashMap;

use super::expr::{self, Expr};

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
    list: Vec<Result<Formula, String>>,
}

impl Formulas {
    /// Compiles the formulas `(name, expression)`; `None` is an entry that is not a text.
    pub fn compile(sources: &[(String, Option<String>)]) -> Formulas {
        let indexes: HashMap<String, usize> = sources
            .iter()
            .enumerate()
            .map(|(index, (name, _))| (name.clone(), index))
            .collect();
        let mut errors: Vec<Option<String>> = vec![None; sources.len()];
        let exprs: Vec<Option<Expr>> = sources
            .iter()
            .zip(&mut errors)
            .map(|((name, source), error)| {
                let parsed = match source {
                    Some(source) => expr::parse(source).map_err(|e| format!("{e} in `{source}`")),
                    None => Err("the expression must be a text".into()),
                };
                parsed
                    .map_err(|e| *error = Some(format!("formula `{name}`: {e}")))
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
                                format!("formula `{name}`: unknown formula `{wanted}`")
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
                (_, error) => Err(error.unwrap_or_default()),
            })
            .collect();
        Formulas { indexes, list }
    }

    /// The index of the formula `name`.
    pub fn index(&self, name: &str) -> Result<usize, String> {
        self.indexes
            .get(name)
            .copied()
            .ok_or_else(|| format!("unknown formula `{name}`"))
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
/// broken one the message of that one. A depth-first walk without recursion.
fn spread_errors(
    sources: &[(String, Option<String>)],
    refs: &[Vec<usize>],
    errors: &mut [Option<String>],
) {
    #[derive(Clone, Copy, PartialEq)]
    enum State {
        New,
        Open,
        Done,
    }
    let mut states = vec![State::New; refs.len()];
    for root in 0..refs.len() {
        if states[root] != State::New {
            continue;
        }
        states[root] = State::Open;
        // The path from the root: a formula and the number of its references that were followed.
        let mut path = vec![(root, 0)];
        while let Some(&(index, followed)) = path.last() {
            let top = path.len() - 1;
            let Some(&next) = refs[index].get(followed) else {
                states[index] = State::Done;
                path.pop();
                if let (Some(error), Some(&(parent, _))) = (errors[index].clone(), path.last()) {
                    errors[parent].get_or_insert(error);
                }
                continue;
            };
            path[top].1 += 1;
            match states[next] {
                State::New => {
                    states[next] = State::Open;
                    path.push((next, 0));
                }
                State::Open => {
                    let start = path.iter().position(|&(i, _)| i == next).unwrap_or(0);
                    let names: Vec<String> = path[start..]
                        .iter()
                        .map(|&(i, _)| i)
                        .chain([next])
                        .map(|i| format!("`{}`", sources[i].0))
                        .collect();
                    let message = format!("the formulas form a cycle: {}", names.join(" → "));
                    for &(i, _) in &path[start..] {
                        errors[i].get_or_insert_with(|| message.clone());
                    }
                }
                State::Done => {
                    if let Some(error) = errors[next].clone() {
                        errors[index].get_or_insert(error);
                    }
                }
            }
        }
    }
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
        assert!(error(&formulas, "f123").unwrap().contains("cycle"));
    }
}
