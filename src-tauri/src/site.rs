//! `nixe export <folder> --site <out>`: a folder of a vault as a static website. One HTML page per
//! note with working wikilinks, a navigation tree, backlinks and a client-side search. The output
//! has no server-side part: every link is relative, so the site works from a subpath (GitHub
//! Pages) and from `file://`. The search index is a script (`search-index.js`), not a JSON file
//! to fetch, for the same reason.
//!
//! Left out of a page: Mermaid (the source stays a code block), math (the source stays text),
//! callout styling, and the content of `![[note]]` embeds (they become a link).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use pulldown_cmark::{html, CowStr, Event, Options, Parser, Tag, TagEnd, TextMergeStream};
use regex::Regex;
use serde_json::Value;

use crate::vault::meta::{extract, split_frontmatter};
use crate::vault::resolve::{is_markdown_path, parse_target, Resolver};
use crate::vault::walk_vault;

/// Directory of the generated files inside the output; the vault's own paths cannot collide with it
/// unless a note folder is named the same.
const ASSET_DIR: &str = "_nixe";
const CSS: &str = include_str!("site/site.css");
const SEARCH_JS: &str = include_str!("site/search.js");
/// Characters of a note kept in the search index.
const SEARCH_TEXT_MAX: usize = 20_000;

#[derive(Debug, Clone)]
pub struct SiteOptions {
    /// The vault root (links resolve against the whole vault).
    pub root: PathBuf,
    /// The exported folder; the root itself or a folder below it.
    pub folder: PathBuf,
    pub out: PathBuf,
    /// Folders left out, relative to the exported folder or to the vault.
    pub exclude: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteSummary {
    pub pages: usize,
    pub files: usize,
    pub excluded: usize,
}

struct Note {
    /// Path in the vault.
    vault: String,
    /// Path of the page, relative to the output, `/`-separated.
    page: String,
    title: String,
    body: String,
    plain: String,
}

struct Rendered {
    html: String,
    plain: String,
    /// Notes this one links to.
    links: BTreeSet<String>,
    /// Vault paths of the files it shows or links.
    files: BTreeSet<String>,
}

/// Writes the site; the summary names what was written.
pub fn export_site(opts: &SiteOptions) -> Result<SiteSummary, String> {
    let root = &opts.root;
    let folder_rel = opts
        .folder
        .strip_prefix(root)
        .map_err(|_| format!("{}: not inside the vault", opts.folder.display()))?
        .to_string_lossy()
        .replace('\\', "/");
    if opts.folder.starts_with(&opts.out) {
        return Err("the output folder holds the exported folder".into());
    }
    let all: Vec<String> = walk_vault(root).into_iter().map(|f| f.path).collect();
    let resolver = Resolver::new(&all);
    let prefix = if folder_rel.is_empty() {
        String::new()
    } else {
        format!("{folder_rel}/")
    };
    let exclude = clean_exclude(&opts.exclude);

    // Which notes are published.
    let mut included: BTreeMap<String, (String, String, String)> = BTreeMap::new();
    let mut excluded = 0;
    for path in all
        .iter()
        .filter(|p| is_markdown_path(p) && p.starts_with(&prefix))
    {
        let rel = &path[prefix.len()..];
        let Some(text) = published_text(root, path, &prefix, &exclude)? else {
            excluded += 1;
            continue;
        };
        let meta = extract(&text);
        let title = meta
            .properties
            .iter()
            .find(|p| p.key == "title")
            .and_then(|p| p.value.as_str().map(str::to_string))
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| stem(rel));
        let body = split_frontmatter(&text).map_or(text.as_str(), |(_, b)| b);
        included.insert(path.clone(), (rel.to_string(), title, body.to_string()));
    }

    let mut pages: BTreeMap<String, String> = BTreeMap::new();
    for (vault, (rel, _, _)) in &included {
        pages.insert(vault.clone(), page_path(rel));
    }
    let has_home = pages.values().any(|p| p == "index.html");

    let ctx = Ctx {
        root,
        prefix: &prefix,
        all: &all,
        resolver: &resolver,
        pages: &pages,
        exclude: &exclude,
    };
    let mut notes = Vec::new();
    let mut links: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut files: BTreeSet<String> = BTreeSet::new();
    for (vault, (_, title, body)) in &included {
        let rendered = render(&ctx, vault, body);
        links.insert(vault.clone(), rendered.links);
        files.extend(rendered.files);
        notes.push(Note {
            vault: vault.clone(),
            page: pages[vault].clone(),
            title: title.clone(),
            body: rendered.html,
            plain: rendered.plain,
        });
    }
    let mut backlinks: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (source, targets) in &links {
        for target in targets.iter().filter(|t| *t != source) {
            backlinks.entry(target).or_default().push(source);
        }
    }

    let site_name = opts
        .folder
        .file_name()
        .map_or_else(|| "Notes".to_string(), |n| n.to_string_lossy().into_owned());
    fs::create_dir_all(opts.out.join(ASSET_DIR))
        .map_err(|e| format!("{}: {e}", opts.out.display()))?;
    let titles: HashMap<&str, &str> = notes
        .iter()
        .map(|n| (n.vault.as_str(), n.title.as_str()))
        .collect();
    let tree_entries: Vec<(&str, &str)> = notes
        .iter()
        .map(|n| (n.page.as_str(), n.title.as_str()))
        .collect();

    for note in &notes {
        let back: Vec<(&str, &str)> = backlinks
            .get(note.vault.as_str())
            .map(|sources| {
                sources
                    .iter()
                    .map(|s| (pages[*s].as_str(), titles[s]))
                    .collect()
            })
            .unwrap_or_default();
        let page = layout(
            &site_name,
            &note.title,
            &note.page,
            &format!(
                "<article>\n{}</article>\n{}",
                note.body,
                backlinks_html(&note.page, &back)
            ),
            &tree_entries,
        );
        write(&opts.out.join(&note.page), page.as_bytes())?;
    }
    if !has_home {
        let list: String = tree_entries
            .iter()
            .map(|(p, t)| {
                format!(
                    "<li><a href=\"{}\">{}</a></li>\n",
                    encode_path(p),
                    escape(t)
                )
            })
            .collect();
        let body = format!(
            "<article>\n<h1>{}</h1>\n<ul>\n{list}</ul>\n</article>\n",
            escape(&site_name)
        );
        let page = layout(&site_name, &site_name, "index.html", &body, &tree_entries);
        write(&opts.out.join("index.html"), page.as_bytes())?;
    }

    // Files shown or linked by a page.
    let mut copied = 0;
    for vault in &files {
        let target = opts.out.join(asset_path(&prefix, vault));
        if let Some(dir) = target.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        fs::copy(root.join(vault), &target).map_err(|e| format!("{vault}: {e}"))?;
        copied += 1;
    }

    let index: Vec<Value> = notes
        .iter()
        .map(|n| {
            serde_json::json!({
                "t": n.title,
                "p": encode_path(&n.page),
                "x": n.plain.chars().take(SEARCH_TEXT_MAX).collect::<String>(),
            })
        })
        .collect();
    let index_js = format!(
        "window.NIXE_SEARCH = {};\n",
        serde_json::to_string(&index).map_err(|e| e.to_string())?
    );
    write(
        &opts.out.join(ASSET_DIR).join("search-index.js"),
        index_js.as_bytes(),
    )?;
    write(
        &opts.out.join(ASSET_DIR).join("search.js"),
        SEARCH_JS.as_bytes(),
    )?;
    write(&opts.out.join(ASSET_DIR).join("site.css"), CSS.as_bytes())?;
    // GitHub Pages would run Jekyll over files that start with an underscore otherwise.
    write(&opts.out.join(".nojekyll"), b"")?;

    Ok(SiteSummary {
        pages: notes.len() + usize::from(!has_home),
        files: copied,
        excluded,
    })
}

/// The `--exclude` folders in the spelling `in_excluded` compares.
pub(crate) fn clean_exclude(exclude: &[String]) -> Vec<String> {
    exclude
        .iter()
        .map(|e| e.trim().trim_matches('/').replace('\\', "/"))
        .filter(|e| !e.is_empty())
        .collect()
}

/// The text of the note `path` (a vault path), without a byte order mark; `None` when an export of
/// a folder leaves it out: it lies in an excluded folder or says `publish: false`.
pub(crate) fn published_text(
    root: &Path,
    path: &str,
    prefix: &str,
    exclude: &[String],
) -> Result<Option<String>, String> {
    if in_excluded(exclude, prefix, path) {
        return Ok(None);
    }
    let text = fs::read_to_string(root.join(path))
        .map_err(|e| format!("{path}: {e}"))?
        .trim_start_matches('\u{feff}')
        .to_string();
    let unpublished = extract(&text)
        .properties
        .iter()
        .any(|p| p.key == "publish" && is_false(&p.value));
    Ok((!unpublished).then_some(text))
}

/// True when `vault` (a vault path) lies in a folder named by `--exclude`, relative to the exported
/// folder or to the vault.
fn in_excluded(exclude: &[String], prefix: &str, vault: &str) -> bool {
    let rel = vault.strip_prefix(prefix).unwrap_or(vault);
    exclude.iter().any(|e| {
        [rel, vault]
            .iter()
            .any(|p| *p == e || p.starts_with(&format!("{e}/")))
    })
}

fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    fs::write(path, bytes).map_err(|e| format!("{}: {e}", path.display()))
}

fn is_false(v: &Value) -> bool {
    match v {
        Value::Bool(b) => !b,
        Value::String(s) => matches!(s.trim().to_lowercase().as_str(), "false" | "no"),
        _ => false,
    }
}

fn stem(rel: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.rsplit_once('.').map_or(name, |(s, _)| s).to_string()
}

/// `folder/Note.md` becomes `folder/Note.html`; a note `index.md` at the top is the home page.
fn page_path(rel: &str) -> String {
    if rel.eq_ignore_ascii_case("index.md") {
        return "index.html".into();
    }
    let stem_len = rel.rfind('.').unwrap_or(rel.len());
    format!("{}.html", &rel[..stem_len])
}

/// Where a file the pages use lies in the output: below the exported folder as it is, elsewhere
/// in the vault under `_nixe/files/`.
fn asset_path(prefix: &str, vault: &str) -> String {
    match vault.strip_prefix(prefix) {
        Some(rel) if !rel.starts_with(ASSET_DIR) => rel.to_string(),
        _ => format!("{ASSET_DIR}/files/{vault}"),
    }
}

struct Ctx<'a> {
    root: &'a Path,
    prefix: &'a str,
    all: &'a [String],
    resolver: &'a Resolver,
    pages: &'a BTreeMap<String, String>,
    exclude: &'a [String],
}

/// A link target inside the site.
enum Dest {
    /// Page of a published note.
    Page(String),
    /// A file of the vault that is copied.
    File(String),
    /// Missing, ambiguous, unpublished or outside the folder.
    None,
}

impl Ctx<'_> {
    fn dest(&self, vault: Option<String>) -> Dest {
        let Some(vault) = vault else {
            return Dest::None;
        };
        if is_markdown_path(&vault) {
            return self
                .pages
                .get(&vault)
                .map_or(Dest::None, |p| Dest::Page(p.clone()));
        }
        // Neither an excluded folder nor a hidden one (`.obsidian`, `.git`) is published.
        let hidden = vault.split('/').any(|s| s.starts_with('.'));
        if !hidden
            && !in_excluded(self.exclude, self.prefix, &vault)
            && self.root.join(&vault).is_file()
        {
            Dest::File(vault)
        } else {
            Dest::None
        }
    }
}

/// The path from the page `from` to `to` (both relative to the output), percent-encoded.
fn relative(from: &str, to: &str) -> String {
    let depth = from.matches('/').count();
    format!("{}{}", "../".repeat(depth), encode_path(to))
}

fn encode_path(path: &str) -> String {
    let mut out = String::new();
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The anchor of a heading.
fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.trim().chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        } else if (c.is_whitespace() || c == '-' || c == '_') && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

/// Joins a relative link of the note `vault` and removes `.` and `..`; none when it leaves the vault.
fn join_vault(vault: &str, link: &str) -> Option<String> {
    let mut parts: Vec<&str> = if link.starts_with('/') {
        Vec::new()
    } else {
        let mut p: Vec<&str> = vault.split('/').collect();
        p.pop();
        p
    };
    for seg in link.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}

fn render(ctx: &Ctx, vault: &str, body: &str) -> Rendered {
    let wiki = Regex::new(r"(!?)\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]*))?\]\]").unwrap();
    let comment = Regex::new(r"%%[^\n]*?%%").unwrap();
    let scheme = Regex::new(r"^[A-Za-z][A-Za-z0-9+.\-]*:").unwrap();
    let page = ctx.pages[vault].clone();
    let mut links = BTreeSet::new();
    let mut files = BTreeSet::new();
    let mut plain = String::new();

    let opts = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES;
    let events: Vec<Event> = TextMergeStream::new(Parser::new_ext(body, opts)).collect();

    let mut out: Vec<Event> = Vec::with_capacity(events.len());
    let mut kept: Vec<bool> = Vec::new();
    let mut in_code = false;
    let mut used_ids: HashMap<String, usize> = HashMap::new();
    let mut i = 0;
    while i < events.len() {
        let event = events[i].clone();
        i += 1;
        match event {
            Event::Start(Tag::Heading {
                level,
                classes,
                attrs,
                ..
            }) => {
                let mut text = String::new();
                for e in &events[i..] {
                    match e {
                        Event::End(TagEnd::Heading(_)) => break,
                        Event::Text(t) | Event::Code(t) => text.push_str(t),
                        _ => {}
                    }
                }
                let base = slug(&text);
                let n = used_ids.entry(base.clone()).or_insert(0);
                let id = if *n == 0 { base } else { format!("{base}-{n}") };
                *n += 1;
                out.push(Event::Start(Tag::Heading {
                    level,
                    id: Some(CowStr::from(id)),
                    classes,
                    attrs,
                }));
            }
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                title,
                id,
            }) => {
                let href = match markdown_dest(
                    ctx, vault, &page, &dest_url, &scheme, &mut links, &mut files,
                ) {
                    Some(h) => h,
                    None => {
                        kept.push(false);
                        continue;
                    }
                };
                kept.push(true);
                out.push(Event::Start(Tag::Link {
                    link_type,
                    dest_url: CowStr::from(href),
                    title,
                    id,
                }));
            }
            Event::End(TagEnd::Link) => {
                if kept.pop().unwrap_or(true) {
                    out.push(Event::End(TagEnd::Link));
                }
            }
            Event::Start(Tag::Image {
                link_type,
                dest_url,
                title,
                id,
            }) => {
                let src = markdown_dest(
                    ctx, vault, &page, &dest_url, &scheme, &mut links, &mut files,
                )
                .unwrap_or_default();
                out.push(Event::Start(Tag::Image {
                    link_type,
                    dest_url: CowStr::from(src),
                    title,
                    id,
                }));
            }
            // Raw HTML of a note is shown as text: a published page runs no script of a note.
            Event::Html(h) | Event::InlineHtml(h) => out.push(Event::Text(h)),
            Event::Code(c) => {
                plain.push_str(&c);
                plain.push(' ');
                out.push(Event::Code(c));
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                in_code = true;
                out.push(Event::Start(Tag::CodeBlock(kind)));
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code = false;
                out.push(Event::End(TagEnd::CodeBlock));
            }
            Event::Text(text) if in_code => {
                plain.push_str(&text);
                out.push(Event::Text(text));
            }
            Event::Text(text) => {
                let text = comment.replace_all(&text, "").into_owned();
                let mut last = 0;
                for m in wiki.captures_iter(&text) {
                    let whole = m.get(0).unwrap();
                    push_text(&mut out, &mut plain, &text[last..whole.start()]);
                    last = whole.end();
                    let embed = &m[1] == "!";
                    let target = m[2].trim();
                    let alias = m
                        .get(3)
                        .map(|a| a.as_str().trim())
                        .filter(|a| !a.is_empty());
                    let parsed = parse_target(target);
                    let label = alias.map_or_else(
                        || {
                            let shown = if parsed.note.is_empty() {
                                target.trim_start_matches('#')
                            } else {
                                target
                            };
                            shown.replace('#', " > ")
                        },
                        str::to_string,
                    );
                    let dest = if parsed.note.is_empty() {
                        Dest::Page(page.clone())
                    } else {
                        ctx.dest(ctx.resolver.resolve(target))
                    };
                    let resolved = if parsed.note.is_empty() {
                        Some(vault.to_string())
                    } else {
                        ctx.resolver.resolve(target)
                    };
                    let html = match dest {
                        Dest::Page(p) => {
                            if let Some(r) = resolved.filter(|r| r != vault) {
                                links.insert(r);
                            }
                            let anchor = parsed
                                .heading
                                .as_deref()
                                .map(|h| format!("#{}", slug(h)))
                                .unwrap_or_default();
                            let href = if p == page {
                                anchor
                            } else {
                                format!("{}{anchor}", relative(&page, &p))
                            };
                            format!(
                                "<a class=\"wikilink\" href=\"{href}\">{}</a>",
                                escape(&label)
                            )
                        }
                        Dest::File(f) => {
                            let href = relative(&page, &asset_path(ctx.prefix, &f));
                            files.insert(f.clone());
                            let image = embed && is_image(&f);
                            if image {
                                format!(
                                    "<img src=\"{href}\" alt=\"{}\">",
                                    escape(alias.unwrap_or(&f))
                                )
                            } else {
                                format!(
                                    "<a class=\"wikilink\" href=\"{href}\">{}</a>",
                                    escape(&label)
                                )
                            }
                        }
                        Dest::None => {
                            format!("<span class=\"unpublished\">{}</span>", escape(&label))
                        }
                    };
                    plain.push_str(&label);
                    out.push(Event::Html(CowStr::from(html)));
                }
                push_text(&mut out, &mut plain, &text[last..]);
            }
            Event::SoftBreak | Event::HardBreak => {
                plain.push(' ');
                out.push(event);
            }
            other => out.push(other),
        }
    }
    let mut html_out = String::new();
    html::push_html(&mut html_out, out.into_iter());
    Rendered {
        html: html_out,
        plain: plain.split_whitespace().collect::<Vec<_>>().join(" "),
        links,
        files,
    }
}

fn push_text<'a>(out: &mut Vec<Event<'a>>, plain: &mut String, s: &str) {
    if !s.is_empty() {
        plain.push_str(s);
        out.push(Event::Text(CowStr::from(s.to_string())));
    }
}

fn is_image(path: &str) -> bool {
    let lower = path.to_lowercase();
    [
        ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".bmp",
    ]
    .iter()
    .any(|e| lower.ends_with(e))
}

/// The address a Markdown link or image gets on the page; `None` turns a link into plain text.
fn markdown_dest(
    ctx: &Ctx,
    vault: &str,
    page: &str,
    dest: &str,
    scheme: &Regex,
    links: &mut BTreeSet<String>,
    files: &mut BTreeSet<String>,
) -> Option<String> {
    if let Some(m) = scheme.find(dest) {
        let name = m.as_str().trim_end_matches(':').to_lowercase();
        return matches!(name.as_str(), "http" | "https" | "mailto" | "tel")
            .then(|| dest.to_string());
    }
    if dest.starts_with("//") {
        return Some(dest.to_string());
    }
    if dest.starts_with('#') {
        return Some(format!("#{}", slug(&decode(&dest[1..]))));
    }
    let (path, fragment) = match dest.split_once('#') {
        Some((p, f)) => (p, Some(f)),
        None => (dest, None),
    };
    let path = decode(path.split('?').next().unwrap_or(path));
    let target = join_vault(vault, &path)?;
    if !ctx.all.iter().any(|f| *f == target) {
        return None;
    }
    match ctx.dest(Some(target.clone())) {
        Dest::Page(p) => {
            if target != vault {
                links.insert(target);
            }
            let anchor = fragment
                .map(|f| format!("#{}", slug(&decode(f))))
                .unwrap_or_default();
            Some(if p == page {
                anchor
            } else {
                format!("{}{anchor}", relative(page, &p))
            })
        }
        Dest::File(f) => {
            files.insert(f.clone());
            Some(relative(page, &asset_path(ctx.prefix, &f)))
        }
        Dest::None => None,
    }
}

fn backlinks_html(page: &str, back: &[(&str, &str)]) -> String {
    if back.is_empty() {
        return String::new();
    }
    let items: String = back
        .iter()
        .map(|(p, t)| {
            format!(
                "<li><a href=\"{}\">{}</a></li>\n",
                relative(page, p),
                escape(t)
            )
        })
        .collect();
    format!("<section class=\"backlinks\" aria-label=\"Backlinks\">\n<h2>Backlinks</h2>\n<ul>\n{items}</ul>\n</section>\n")
}

#[derive(Default)]
struct TreeNode<'a> {
    folders: BTreeMap<&'a str, TreeNode<'a>>,
    notes: Vec<(&'a str, &'a str)>,
}

fn tree_html(node: &TreeNode, current: &str, from: &str, prefix: &str) -> String {
    let mut out = String::from("<ul>\n");
    for (name, child) in &node.folders {
        let path = format!("{prefix}{name}/");
        let open = if current.starts_with(&path) {
            " open"
        } else {
            ""
        };
        out.push_str(&format!(
            "<li><details{open}><summary>{}</summary>\n{}</details></li>\n",
            escape(name),
            tree_html(child, current, from, &path)
        ));
    }
    for (page, title) in &node.notes {
        let here = if *page == current {
            " aria-current=\"page\""
        } else {
            ""
        };
        out.push_str(&format!(
            "<li><a href=\"{}\"{here}>{}</a></li>\n",
            relative(from, page),
            escape(title)
        ));
    }
    out.push_str("</ul>\n");
    out
}

fn layout(site: &str, title: &str, page: &str, content: &str, entries: &[(&str, &str)]) -> String {
    let mut root = TreeNode::default();
    for (path, t) in entries {
        let mut node = &mut root;
        let mut parts: Vec<&str> = path.split('/').collect();
        parts.pop();
        for dir in parts {
            node = node.folders.entry(dir).or_default();
        }
        node.notes.push((path, t));
    }
    let up = "../".repeat(page.matches('/').count());
    let tree = tree_html(&root, page, page, "");
    let heading = if title == site {
        escape(site)
    } else {
        format!("{} – {}", escape(title), escape(site))
    };
    format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>{heading}</title>\n\
<link rel=\"stylesheet\" href=\"{up}{ASSET_DIR}/site.css\">\n</head>\n<body data-root=\"{up}\">\n\
<header>\n<a class=\"site\" href=\"{up}index.html\">{site}</a>\n\
<input type=\"search\" id=\"q\" placeholder=\"Search\" aria-label=\"Search\" autocomplete=\"off\">\n\
<ul id=\"results\" hidden></ul>\n</header>\n<div class=\"layout\">\n<nav aria-label=\"Notes\">\n{tree}</nav>\n\
<main>\n{content}</main>\n</div>\n\
<script src=\"{up}{ASSET_DIR}/search-index.js\"></script>\n<script src=\"{up}{ASSET_DIR}/search.js\"></script>\n</body>\n</html>\n",
        site = escape(site),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_encoded_and_decoded() {
        assert_eq!(encode_path("a b/Ü.html"), "a%20b/%C3%9C.html");
        assert_eq!(decode("a%20b/%C3%9C%"), "a b/Ü%");
        assert_eq!(decode("%zz%4"), "%zz%4");
    }

    #[test]
    fn pages_are_relative_to_the_output() {
        assert_eq!(page_path("a/B.md"), "a/B.html");
        assert_eq!(page_path("Index.md"), "index.html");
        assert_eq!(relative("a/b/C.html", "D.html"), "../../D.html");
        assert_eq!(relative("C.html", "a b/D.html"), "a%20b/D.html");
    }

    #[test]
    fn links_are_joined_inside_the_vault() {
        assert_eq!(join_vault("a/B.md", "../C.md").as_deref(), Some("C.md"));
        assert_eq!(join_vault("a/B.md", "/x/C.md").as_deref(), Some("x/C.md"));
        assert_eq!(join_vault("a/B.md", "../../C.md"), None);
    }

    #[test]
    fn headings_get_anchors() {
        assert_eq!(slug("Second heading!"), "second-heading");
        assert_eq!(slug("  A_b -- c "), "a-b-c");
    }

    #[test]
    fn publish_false_is_recognised() {
        assert!(is_false(&Value::Bool(false)));
        assert!(is_false(&Value::String("No".into())));
        assert!(!is_false(&Value::Bool(true)));
    }
}
