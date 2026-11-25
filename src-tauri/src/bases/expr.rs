//! The expression language of filters (<https://obsidian.md/help/bases/syntax>): literals, note
//! properties, `file.*` fields, file functions and operators. Parsing checks every name, so an
//! expression that parses can be evaluated on every note.

/// Most tokens of one expression; also bounds the depth of the tree.
const MAX_TOKENS: usize = 500;
/// Most nested parentheses, lists, calls and unary operators.
const MAX_DEPTH: usize = 50;

/// A field of `file.`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Name,
    Basename,
    Path,
    Folder,
    Ext,
    Size,
    Ctime,
    Mtime,
    Tags,
    Links,
    Embeds,
    Backlinks,
    Properties,
}

impl Field {
    pub fn from_name(name: &str) -> Option<Field> {
        Some(match name {
            "name" => Field::Name,
            "basename" => Field::Basename,
            "path" => Field::Path,
            "folder" => Field::Folder,
            "ext" => Field::Ext,
            "size" => Field::Size,
            "ctime" => Field::Ctime,
            "mtime" => Field::Mtime,
            "tags" => Field::Tags,
            "links" => Field::Links,
            "embeds" => Field::Embeds,
            "backlinks" => Field::Backlinks,
            "properties" => Field::Properties,
            _ => return None,
        })
    }
}

/// A function of `file.`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Function {
    HasTag,
    InFolder,
    HasLink,
    HasProperty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Or,
    And,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Add,
    Sub,
    Mul,
    Div,
    Rem,
}

/// The binary operators, loosest binding first (the precedence of JavaScript).
const LEVELS: &[&[(&str, Op)]] = &[
    &[("||", Op::Or)],
    &[("&&", Op::And)],
    &[("==", Op::Eq), ("!=", Op::Ne)],
    &[("<=", Op::Le), (">=", Op::Ge), ("<", Op::Lt), (">", Op::Gt)],
    &[("+", Op::Add), ("-", Op::Sub)],
    &[("*", Op::Mul), ("/", Op::Div), ("%", Op::Rem)],
];

/// Every symbol; the longer ones first.
const SYMBOLS: &[&str] = &[
    "||", "&&", "==", "!=", "<=", ">=", "<", ">", "+", "-", "*", "/", "%", "!", "(", ")", "[", "]",
    ",", ".",
];

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Text(String),
    Number(f64),
    Bool(bool),
    List(Vec<Expr>),
    /// A note property, by name.
    Property(String),
    File(Field),
    Call(Function, Vec<Expr>),
    Not(Box<Expr>),
    Negate(Box<Expr>),
    Binary(Op, Box<Expr>, Box<Expr>),
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Text(String),
    Number(f64),
    Name(String),
    Symbol(&'static str),
}

/// Parses one expression; the error says what is wrong, without naming the expression.
pub fn parse(source: &str) -> Result<Expr, String> {
    let mut parser = Parser {
        tokens: tokens(source)?,
        next: 0,
        depth: 0,
    };
    let expr = parser.binary(0)?;
    match parser.peek() {
        None => Ok(expr),
        Some(token) => Err(format!("syntax error: unexpected {}", describe(token))),
    }
}

fn describe(token: &Token) -> String {
    match token {
        Token::Text(s) => format!("\"{s}\""),
        Token::Number(n) => format!("`{n}`"),
        Token::Name(s) => format!("`{s}`"),
        Token::Symbol(s) => format!("`{s}`"),
    }
}

fn tokens(source: &str) -> Result<Vec<Token>, String> {
    let mut out = Vec::new();
    let mut rest = source.trim_start();
    while let Some(c) = rest.chars().next() {
        let used = if c == '"' || c == '\'' {
            let (text, used) = string(rest, c)?;
            out.push(Token::Text(text));
            used
        } else if c.is_ascii_digit() {
            let mut end = digits(rest, 0);
            if rest[end..].starts_with('.') && digits(rest, end + 1) > end + 1 {
                end = digits(rest, end + 1);
            }
            let number = rest[..end]
                .parse()
                .map_err(|_| format!("syntax error: invalid number `{}`", &rest[..end]))?;
            out.push(Token::Number(number));
            end
        } else if c.is_alphabetic() || c == '_' || c == '$' {
            let end = rest
                .find(|c: char| !(c.is_alphanumeric() || c == '_' || c == '$'))
                .unwrap_or(rest.len());
            out.push(Token::Name(rest[..end].to_string()));
            end
        } else if let Some(symbol) = SYMBOLS.iter().find(|s| rest.starts_with(**s)) {
            out.push(Token::Symbol(symbol));
            symbol.len()
        } else {
            return Err(format!("syntax error: unexpected `{c}`"));
        };
        if out.len() > MAX_TOKENS {
            return Err("syntax error: the expression is too long".into());
        }
        rest = rest[used..].trim_start();
    }
    Ok(out)
}

/// The end of the run of digits that starts at `from`.
fn digits(s: &str, from: usize) -> usize {
    from + s[from..].bytes().take_while(u8::is_ascii_digit).count()
}

/// The string literal at the start of `s`, and the bytes it takes.
fn string(s: &str, quote: char) -> Result<(String, usize), String> {
    let mut out = String::new();
    let mut chars = s.char_indices().skip(1);
    while let Some((i, c)) = chars.next() {
        if c == quote {
            return Ok((out, i + 1));
        }
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some((_, 'n')) => out.push('\n'),
            Some((_, 't')) => out.push('\t'),
            Some((_, other)) => out.push(other),
            None => break,
        }
    }
    Err("syntax error: a string is not closed".into())
}

struct Parser {
    tokens: Vec<Token>,
    next: usize,
    depth: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.next)
    }

    fn take(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.next).cloned();
        self.next += 1;
        token
    }

    fn eat(&mut self, symbol: &str) -> bool {
        let found = matches!(self.peek(), Some(Token::Symbol(s)) if *s == symbol);
        if found {
            self.next += 1;
        }
        found
    }

    fn expect(&mut self, symbol: &str) -> Result<(), String> {
        if self.eat(symbol) {
            return Ok(());
        }
        Err(match self.peek() {
            Some(token) => format!(
                "syntax error: expected `{symbol}`, found {}",
                describe(token)
            ),
            None => format!("syntax error: expected `{symbol}` at the end"),
        })
    }

    /// The expression of the operators of `LEVELS[level]` and tighter ones.
    fn binary(&mut self, level: usize) -> Result<Expr, String> {
        let Some(operators) = LEVELS.get(level) else {
            return self.unary();
        };
        let mut left = self.binary(level + 1)?;
        while let Some(&(_, op)) = operators.iter().find(|(symbol, _)| self.eat(symbol)) {
            let right = self.binary(level + 1)?;
            left = Expr::Binary(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn unary(&mut self) -> Result<Expr, String> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err("syntax error: the expression is nested too deeply".into());
        }
        let expr = if self.eat("!") {
            Expr::Not(Box::new(self.unary()?))
        } else if self.eat("-") {
            Expr::Negate(Box::new(self.unary()?))
        } else {
            let primary = self.primary()?;
            // Members and methods of values are not part of the language yet.
            if self.eat(".") {
                return Err(match (self.take(), self.eat("(")) {
                    (Some(Token::Name(name)), true) => format!("unknown function `{name}`"),
                    (Some(Token::Name(name)), false) => format!("unknown field `{name}`"),
                    _ => "syntax error: expected a name after `.`".into(),
                });
            }
            if self.eat("[") {
                return Err("syntax error: access by `[…]` is only supported after `note`".into());
            }
            primary
        };
        self.depth -= 1;
        Ok(expr)
    }

    fn primary(&mut self) -> Result<Expr, String> {
        match self.take() {
            Some(Token::Text(s)) => Ok(Expr::Text(s)),
            Some(Token::Number(n)) => Ok(Expr::Number(n)),
            Some(Token::Name(name)) => self.name(name),
            Some(Token::Symbol("(")) => {
                let inner = self.binary(0)?;
                self.expect(")")?;
                Ok(inner)
            }
            Some(Token::Symbol("[")) => Ok(Expr::List(self.items("]")?)),
            Some(token) => Err(format!("syntax error: unexpected {}", describe(&token))),
            None => Err("syntax error: unexpected end".into()),
        }
    }

    /// Comma separated expressions up to `close`.
    fn items(&mut self, close: &str) -> Result<Vec<Expr>, String> {
        let mut items = Vec::new();
        while !self.eat(close) {
            items.push(self.binary(0)?);
            if !self.eat(",") {
                self.expect(close)?;
                break;
            }
        }
        Ok(items)
    }

    fn name(&mut self, name: String) -> Result<Expr, String> {
        if self.eat("(") {
            return Err(format!("unknown function `{name}`"));
        }
        match name.as_str() {
            "true" => Ok(Expr::Bool(true)),
            "false" => Ok(Expr::Bool(false)),
            "file" => self.file(),
            "note" => self.note(),
            "formula" => Err("`formula.` properties are not supported yet".into()),
            "this" => Err("`this` is not supported yet".into()),
            _ => Ok(Expr::Property(name)),
        }
    }

    /// What follows `note`: `.x` or `["x"]`.
    fn note(&mut self) -> Result<Expr, String> {
        if self.eat(".") {
            if let Some(Token::Name(name)) = self.take() {
                if self.eat("(") {
                    return Err(format!("unknown function `note.{name}`"));
                }
                return Ok(Expr::Property(name));
            }
        } else if self.eat("[") {
            if let Some(Token::Text(name)) = self.take() {
                self.expect("]")?;
                return Ok(Expr::Property(name));
            }
        }
        Err("syntax error: expected `note.name` or `note[\"name\"]`".into())
    }

    /// What follows `file`: `.field` or `.function(…)`.
    fn file(&mut self) -> Result<Expr, String> {
        let name = match (self.eat("."), self.take()) {
            (true, Some(Token::Name(name))) => name,
            _ => return Err("syntax error: expected `file.` and a name".into()),
        };
        if !self.eat("(") {
            return Field::from_name(&name)
                .map(Expr::File)
                .ok_or_else(|| format!("unknown field `file.{name}`"));
        }
        let function = match name.as_str() {
            "hasTag" => Function::HasTag,
            "inFolder" => Function::InFolder,
            "hasLink" => Function::HasLink,
            "hasProperty" => Function::HasProperty,
            _ => return Err(format!("unknown function `file.{name}`")),
        };
        let args = self.items(")")?;
        if function == Function::HasTag {
            if args.is_empty() {
                return Err("`file.hasTag` needs at least one argument".into());
            }
        } else if args.len() != 1 {
            return Err(format!("`file.{name}` needs exactly one argument"));
        }
        Ok(Expr::Call(function, args))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operators_bind_like_in_javascript() {
        // The parentheses spell out the tree the plain form has to give.
        for (plain, grouped) in [
            (
                "a || b && c == d < e + f * g",
                "a || (b && (c == (d < (e + (f * g)))))",
            ),
            ("1 - 2 - 3", "(1 - 2) - 3"),
            ("8 / 4 % 3 * 2", "((8 / 4) % 3) * 2"),
            ("!a && -b >= 1", "(!a) && ((-b) >= 1)"),
            ("a != b <= c", "a != (b <= c)"),
        ] {
            assert_eq!(parse(plain).unwrap(), parse(grouped).unwrap(), "{plain}");
        }
    }

    #[test]
    fn reads_literals_and_names() {
        assert_eq!(parse(r#""a \"b\" \\ \n""#), Ok(text("a \"b\" \\ \n")));
        assert_eq!(parse(r"'it\'s'"), Ok(text("it's")));
        assert_eq!(parse("1.50"), Ok(Expr::Number(1.5)));
        assert_eq!(parse("false"), Ok(Expr::Bool(false)));
        assert_eq!(parse("[]"), Ok(Expr::List(vec![])));
        assert_eq!(
            parse("[1, 'a', [true],]"),
            Ok(Expr::List(vec![
                Expr::Number(1.0),
                text("a"),
                Expr::List(vec![Expr::Bool(true)]),
            ]))
        );
        for source in ["price", "note.price", "note[\"price\"]", "note['price']"] {
            assert_eq!(parse(source), Ok(Expr::Property("price".into())));
        }
        assert_eq!(
            parse("note[\"my price\"]"),
            Ok(Expr::Property("my price".into()))
        );
        assert_eq!(parse("Länge_2"), Ok(Expr::Property("Länge_2".into())));
        assert_eq!(parse("file.mtime"), Ok(Expr::File(Field::Mtime)));
        assert_eq!(
            parse("file.hasTag('a', 'b')"),
            Ok(Expr::Call(Function::HasTag, vec![text("a"), text("b")]))
        );
    }

    fn text(s: &str) -> Expr {
        Expr::Text(s.into())
    }

    #[test]
    fn errors_say_what_is_wrong() {
        for (source, wanted) in [
            ("", "unexpected end"),
            ("a ==", "unexpected end"),
            ("a = 1", "unexpected `=`"),
            ("a & b", "unexpected `&`"),
            ("(a", "expected `)` at the end"),
            ("[1 2]", "expected `]`, found `2`"),
            ("a b", "unexpected `b`"),
            ("1.", "expected a name after `.`"),
            ("'open", "not closed"),
            ("'open\\", "not closed"),
            ("date('2026-01-01')", "unknown function `date`"),
            ("status.contains('x')", "unknown function `contains`"),
            ("file.tags.contains('x')", "unknown function `contains`"),
            ("file.hasTags('x')", "unknown function `file.hasTags`"),
            ("note.lower()", "unknown function `note.lower`"),
            ("status.length", "unknown field `length`"),
            ("file.sise > 1", "unknown field `file.sise`"),
            ("file", "expected `file.`"),
            ("note", "expected `note.name`"),
            ("note[1]", "expected `note.name`"),
            ("tags[0]", "only supported after `note`"),
            ("formula.x > 1", "`formula.` properties are not supported"),
            ("file.hasLink(this.file)", "`this` is not supported"),
            ("file.hasTag()", "at least one argument"),
            ("file.inFolder()", "exactly one argument"),
            ("file.hasLink('a', 'b')", "exactly one argument"),
        ] {
            let error = parse(source).unwrap_err();
            assert!(error.contains(wanted), "{source}: {error}");
        }
    }

    #[test]
    fn deep_and_long_expressions_are_refused() {
        for source in [
            format!("{}1{}", "(".repeat(100), ")".repeat(100)),
            format!("{}a", "!".repeat(100)),
        ] {
            assert!(parse(&source).unwrap_err().contains("nested too deeply"));
        }
        let long = format!("1{}", " + 1".repeat(1000));
        assert!(parse(&long).unwrap_err().contains("too long"));
        assert!(parse(&format!("1{}", " + 1".repeat(200))).is_ok());
    }
}
