//! The expression language of filters and formulas (<https://obsidian.md/help/bases/syntax>):
//! literals, note properties, `file.*` fields, `formula.*` properties, functions and operators.
//! Parsing checks every function name and its number of arguments.

use super::date::Part;

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

/// A global function.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Global {
    If,
    List,
    Number,
    Min,
    Max,
    Link,
    Date,
    Duration,
    Now,
    Today,
}

impl Global {
    /// The function and the fewest and most arguments it takes.
    fn from_name(name: &str) -> Option<(Global, usize, usize)> {
        Some(match name {
            "if" => (Global::If, 2, 3),
            "list" => (Global::List, 1, 1),
            "number" => (Global::Number, 1, 1),
            "min" => (Global::Min, 1, usize::MAX),
            "max" => (Global::Max, 1, usize::MAX),
            "link" => (Global::Link, 1, 2),
            "date" => (Global::Date, 1, 1),
            "duration" => (Global::Duration, 1, 1),
            "now" => (Global::Now, 0, 0),
            "today" => (Global::Today, 0, 0),
            _ => return None,
        })
    }
}

/// A function of a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    IsTruthy,
    IsType,
    ToString,
    IsEmpty,
    Contains,
    ContainsAll,
    ContainsAny,
    StartsWith,
    EndsWith,
    Lower,
    Title,
    Trim,
    Replace,
    Slice,
    Split,
    Repeat,
    Reverse,
    Join,
    Flat,
    Unique,
    Sort,
    Format,
    Date,
    Time,
    Relative,
    Abs,
    Ceil,
    Floor,
    Round,
    ToFixed,
}

impl Method {
    /// The method and the fewest and most arguments it takes.
    fn from_name(name: &str) -> Option<(Method, usize, usize)> {
        Some(match name {
            "isTruthy" => (Method::IsTruthy, 0, 0),
            "isType" => (Method::IsType, 1, 1),
            "toString" => (Method::ToString, 0, 0),
            "isEmpty" => (Method::IsEmpty, 0, 0),
            "contains" => (Method::Contains, 1, 1),
            "containsAll" => (Method::ContainsAll, 1, usize::MAX),
            "containsAny" => (Method::ContainsAny, 1, usize::MAX),
            "startsWith" => (Method::StartsWith, 1, 1),
            "endsWith" => (Method::EndsWith, 1, 1),
            "lower" => (Method::Lower, 0, 0),
            "title" => (Method::Title, 0, 0),
            "trim" => (Method::Trim, 0, 0),
            "replace" => (Method::Replace, 2, 2),
            "slice" => (Method::Slice, 1, 2),
            "split" => (Method::Split, 1, 2),
            "repeat" => (Method::Repeat, 1, 1),
            "reverse" => (Method::Reverse, 0, 0),
            "join" => (Method::Join, 1, 1),
            "flat" => (Method::Flat, 0, 0),
            "unique" => (Method::Unique, 0, 0),
            "sort" => (Method::Sort, 0, 0),
            "format" => (Method::Format, 1, 1),
            "date" => (Method::Date, 0, 0),
            "time" => (Method::Time, 0, 0),
            "relative" => (Method::Relative, 0, 0),
            "abs" => (Method::Abs, 0, 0),
            "ceil" => (Method::Ceil, 0, 0),
            "floor" => (Method::Floor, 0, 0),
            "round" => (Method::Round, 0, 1),
            "toFixed" => (Method::ToFixed, 1, 1),
            _ => return None,
        })
    }
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
    /// A formula of the base, by name.
    Formula(String),
    /// `this` and `this.file`: the file the base is shown in, as a link to it.
    This,
    /// A property of the file of `this`, by name.
    ThisProperty(String),
    /// A `file.` field of the file of `this`.
    ThisFile(Field),
    /// A file function of the file of `this`; the arguments are those of the row.
    ThisCall(Function, Vec<Expr>),
    Global(Global, Vec<Expr>),
    Method(Box<Expr>, Method, Vec<Expr>),
    /// `.length` of a value.
    Length(Box<Expr>),
    /// A field of a date, like `.year`.
    Part(Box<Expr>, Part),
    Not(Box<Expr>),
    Negate(Box<Expr>),
    Binary(Op, Box<Expr>, Box<Expr>),
}

impl Expr {
    /// Adds the names of the formulas the expression refers to.
    pub fn formulas<'a>(&'a self, names: &mut Vec<&'a str>) {
        match self {
            Expr::Formula(name) => names.push(name),
            Expr::Text(_)
            | Expr::Number(_)
            | Expr::Bool(_)
            | Expr::Property(_)
            | Expr::File(_)
            | Expr::This
            | Expr::ThisProperty(_)
            | Expr::ThisFile(_) => {}
            Expr::List(items)
            | Expr::Call(_, items)
            | Expr::ThisCall(_, items)
            | Expr::Global(_, items) => {
                items.iter().for_each(|i| i.formulas(names));
            }
            Expr::Method(receiver, _, args) => {
                receiver.formulas(names);
                args.iter().for_each(|a| a.formulas(names));
            }
            Expr::Length(inner) | Expr::Part(inner, _) | Expr::Not(inner) | Expr::Negate(inner) => {
                inner.formulas(names)
            }
            Expr::Binary(_, left, right) => {
                left.formulas(names);
                right.formulas(names);
            }
        }
    }
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
            self.postfix()?
        };
        self.depth -= 1;
        Ok(expr)
    }

    /// A primary expression and the fields and functions of its value.
    fn postfix(&mut self) -> Result<Expr, String> {
        let mut expr = self.primary()?;
        while self.eat(".") {
            let Some(Token::Name(name)) = self.take() else {
                return Err("syntax error: expected a name after `.`".into());
            };
            expr = if self.eat("(") {
                let (method, min, max) =
                    Method::from_name(&name).ok_or_else(|| format!("unknown function `{name}`"))?;
                let args = self.arguments(&name, min, max)?;
                Expr::Method(Box::new(expr), method, args)
            } else if name == "length" {
                Expr::Length(Box::new(expr))
            } else if let Some(part) = Part::from_name(&name) {
                Expr::Part(Box::new(expr), part)
            } else {
                return Err(format!("unknown field `{name}`"));
            };
        }
        if self.eat("[") {
            return Err(
                "syntax error: access by `[…]` is only supported after `note` and `formula`".into(),
            );
        }
        Ok(expr)
    }

    /// The arguments of the function `name` after its `(`, from `min` to `max` of them.
    fn arguments(&mut self, name: &str, min: usize, max: usize) -> Result<Vec<Expr>, String> {
        let args = self.items(")")?;
        if (min..=max).contains(&args.len()) {
            return Ok(args);
        }
        let plural = |n: usize| if n == 1 { "argument" } else { "arguments" };
        let wanted = match (min, max) {
            (0, 0) => "no arguments".to_string(),
            (min, usize::MAX) => format!("at least {min} {}", plural(min)),
            (min, max) if min == max => format!("exactly {min} {}", plural(min)),
            (min, max) => format!("{min} to {max} arguments"),
        };
        Err(format!("`{name}` needs {wanted}"))
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
            let (function, min, max) =
                Global::from_name(&name).ok_or_else(|| format!("unknown function `{name}`"))?;
            let args = self.arguments(&name, min, max)?;
            return Ok(Expr::Global(function, args));
        }
        match name.as_str() {
            "true" => Ok(Expr::Bool(true)),
            "false" => Ok(Expr::Bool(false)),
            "file" => self.file(),
            "note" => self.member("note").map(Expr::Property),
            "formula" => self.member("formula").map(Expr::Formula),
            "this" => self.this(),
            _ => Ok(Expr::Property(name)),
        }
    }

    /// The name that follows `note` or `formula`: `.x` or `["x"]`.
    fn member(&mut self, of: &str) -> Result<String, String> {
        if self.eat(".") {
            if let Some(Token::Name(name)) = self.take() {
                if self.eat("(") {
                    return Err(format!("unknown function `{of}.{name}`"));
                }
                return Ok(name);
            }
        } else if self.eat("[") {
            if let Some(Token::Text(name)) = self.take() {
                self.expect("]")?;
                return Ok(name);
            }
        }
        Err(format!(
            "syntax error: expected `{of}.name` or `{of}[\"name\"]`"
        ))
    }

    /// What follows `this`: nothing, `.file`, `.file.field`, `.file.function(…)` or a property
    /// (`.x`, `["x"]`, `.note.x`).
    fn this(&mut self) -> Result<Expr, String> {
        if matches!(self.peek(), Some(Token::Symbol("["))) {
            return self.member("this").map(Expr::ThisProperty);
        }
        if !self.eat(".") {
            return Ok(Expr::This);
        }
        let Some(Token::Name(name)) = self.take() else {
            return Err("syntax error: expected a name after `this.`".into());
        };
        if self.eat("(") {
            return Err(format!("unknown function `this.{name}`"));
        }
        match name.as_str() {
            "file" if matches!(self.peek(), Some(Token::Symbol("."))) => Ok(match self.file()? {
                Expr::File(field) => Expr::ThisFile(field),
                Expr::Call(function, args) => Expr::ThisCall(function, args),
                other => other,
            }),
            "file" => Ok(Expr::This),
            "note" => self.member("note").map(Expr::ThisProperty),
            _ => Ok(Expr::ThisProperty(name)),
        }
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
        for source in ["formula.ppu", "formula[\"ppu\"]"] {
            assert_eq!(parse(source), Ok(Expr::Formula("ppu".into())));
        }
        assert_eq!(
            parse("a.trim().length"),
            Ok(Expr::Length(Box::new(Expr::Method(
                Box::new(Expr::Property("a".into())),
                Method::Trim,
                vec![],
            ))))
        );
        assert_eq!(
            parse("max(1, 2)"),
            Ok(Expr::Global(
                Global::Max,
                vec![Expr::Number(1.0), Expr::Number(2.0)]
            ))
        );
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
            ("html('x')", "unknown function `html`"),
            ("today(1)", "`today` needs no arguments"),
            ("date()", "`date` needs exactly 1 argument"),
            ("created.format()", "`format` needs exactly 1 argument"),
            ("created.years", "unknown field `years`"),
            ("status.containz('x')", "unknown function `containz`"),
            ("status.contains()", "`contains` needs exactly 1 argument"),
            ("status.lower(1)", "`lower` needs no arguments"),
            ("status.slice()", "`slice` needs 1 to 2 arguments"),
            (
                "status.containsAny()",
                "`containsAny` needs at least 1 argument",
            ),
            ("if(a)", "`if` needs 2 to 3 arguments"),
            ("min()", "`min` needs at least 1 argument"),
            ("number(1, 2)", "`number` needs exactly 1 argument"),
            ("file.hasTags('x')", "unknown function `file.hasTags`"),
            ("note.lower()", "unknown function `note.lower`"),
            ("status.size", "unknown field `size`"),
            ("formula", "expected `formula.name`"),
            ("formula.x()", "unknown function `formula.x`"),
            ("file.sise > 1", "unknown field `file.sise`"),
            ("file", "expected `file.`"),
            ("note", "expected `note.name`"),
            ("note[1]", "expected `note.name`"),
            ("tags[0]", "only supported after `note`"),
            ("this.", "expected a name after `this.`"),
            ("this.file.hasTag()", "at least one argument"),
            ("this.file.nope", "unknown field `file.nope`"),
            ("this.lower()", "unknown function `this.lower`"),
            ("this[0]", "expected `this.name`"),
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
