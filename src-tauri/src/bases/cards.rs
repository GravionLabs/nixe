//! The `cards` view: its settings (`image`, `imageFit`, `imageAspectRatio`, `cardSize`, the keys
//! Obsidian writes into a `.base` file) and the cover image of a note. A cover is resolved like an
//! image in a note; the frontend only loads it.

use serde::Serialize;
use serde_yaml_ng::Value as Yaml;

use super::eval::{self, bare_target, Context, Value};
use super::parse::View;
use super::{source_of, Source};
use crate::vault::meta::percent_decode;
use crate::vault::resolve::Resolver;

/// The width of a card in pixels without `cardSize`, and the range it is kept in.
const SIZE: f64 = 200.0;
const SIZES: (f64, f64) = (50.0, 800.0);
/// The height of a cover as a multiple of its width: the range it is kept in.
const RATIOS: (f64, f64) = (0.1, 10.0);
/// Most bytes of the value that names a cover.
const MAX_IMAGE: usize = 4096;
/// The files an image in a note can be (`embed.ts`).
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif"];

/// How an image fills the cover.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageFit {
    /// Fills the cover and is cut where it does not fit.
    Cover,
    /// Shown whole.
    Contain,
}

/// The settings of a `cards` view.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseCards {
    /// Whether the cards have a cover.
    pub image: bool,
    pub image_fit: ImageFit,
    /// The height of the cover as a multiple of its width.
    pub image_aspect_ratio: f64,
    /// The width of a card in pixels.
    pub card_size: f64,
}

/// What the cover of a card shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "lowercase")]
pub enum BaseCover {
    /// An image of the vault, relative to its root.
    Path(String),
    /// An `http` or `https` address.
    Url(String),
    /// A hex color (`#ff8800`).
    Color(String),
}

/// A compiled `cards` view.
pub(super) struct Cards {
    pub settings: BaseCards,
    /// The property the covers come from.
    image: Option<Source>,
}

/// A number of the view, kept in `range`; `default` when left out.
fn number(
    value: &Option<Yaml>,
    key: &str,
    default: f64,
    (min, max): (f64, f64),
) -> Result<f64, String> {
    match value {
        None | Some(Yaml::Null) => Ok(default),
        Some(value) => value
            .as_f64()
            .filter(|n| *n > 0.0)
            .map(|n| n.clamp(min, max))
            .ok_or_else(|| format!("Invalid base: `{key}` of the view must be a number above 0.")),
    }
}

/// Reads the settings of a `cards` view; the error is the message the tab shows. An `image` that
/// cannot be used is named in `unsupported`.
pub(super) fn compile(view: &View, unsupported: &mut Vec<String>) -> Result<Cards, String> {
    let property = match &view.image {
        None | Some(Yaml::Null) => None,
        Some(Yaml::String(s)) => Some(s.as_str()).filter(|s| !s.is_empty()),
        Some(_) => return Err("Invalid base: `image` of the view must be a property name.".into()),
    };
    let image = property.and_then(|id| {
        let source = source_of(id);
        if source.is_none() {
            unsupported.push(format!("image {id}"));
        }
        source
    });
    let image_fit = match &view.image_fit {
        None | Some(Yaml::Null) => ImageFit::Cover,
        Some(value) => match value.as_str() {
            Some("" | "cover") => ImageFit::Cover,
            Some("contain") => ImageFit::Contain,
            _ => {
                return Err(
                    "Invalid base: `imageFit` of the view must be `cover` or `contain`.".into(),
                )
            }
        },
    };
    Ok(Cards {
        settings: BaseCards {
            image: image.is_some(),
            image_fit,
            image_aspect_ratio: number(&view.image_aspect_ratio, "imageAspectRatio", 1.0, RATIOS)?,
            card_size: number(&view.card_size, "cardSize", SIZE, SIZES)?,
        },
        image,
    })
}

impl Cards {
    /// The cover of the note; `None` without a value that names an image or a color, also when its
    /// formula fails. `files` are the files of the vault, sorted.
    pub(super) fn cover(
        &self,
        context: &Context,
        resolver: &Resolver,
        files: &[String],
    ) -> Option<BaseCover> {
        let value = match self.image.as_ref()? {
            Source::FileName => Value::Text(context.note.title.clone()),
            Source::File(field) => context.field(*field),
            Source::Note(name) => context
                .property(name)
                .map_or(Value::Null, eval::property_value),
            Source::Formula(name) => context.formula(name).unwrap_or(Value::Null),
        };
        match value {
            Value::Text(text) => cover_of(&text, &context.note.path, resolver, files),
            Value::Link(link) if link.url => web(&link.target),
            Value::Link(link) => link.path.filter(|p| is_image(p)).map(BaseCover::Path),
            _ => None,
        }
    }
}

fn web(address: &str) -> Option<BaseCover> {
    let lower = address.to_ascii_lowercase();
    ((lower.starts_with("http://") || lower.starts_with("https://")) && address.len() <= MAX_IMAGE)
        .then(|| BaseCover::Url(address.to_string()))
}

fn is_color(text: &str) -> bool {
    text.strip_prefix('#').is_some_and(|hex| {
        matches!(hex.len(), 3 | 4 | 6 | 8) && hex.bytes().all(|b| b.is_ascii_hexdigit())
    })
}

fn is_image(path: &str) -> bool {
    path.rsplit_once('.')
        .is_some_and(|(_, ext)| IMAGE_EXTENSIONS.iter().any(|e| ext.eq_ignore_ascii_case(e)))
}

/// The path `target` names seen from the folder of `note`, or from the root of the vault when it
/// starts with `/`; `None` when it leaves the vault.
fn relative(note: &str, target: &str) -> Option<String> {
    let folder = match note.rsplit_once('/') {
        Some((folder, _)) if !target.starts_with('/') => folder,
        _ => "",
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in folder.split('/').chain(target.split('/')) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part => parts.push(part),
        }
    }
    Some(parts.join("/"))
}

/// The cover a text names: a hex color, a web address, a wikilink or embed (resolved like one in a
/// note, then as a path) or a path (seen from the note like a Markdown image, then resolved like a
/// link).
fn cover_of(text: &str, note: &str, resolver: &Resolver, files: &[String]) -> Option<BaseCover> {
    let text = text.trim();
    if text.is_empty() || text.len() > MAX_IMAGE {
        return None;
    }
    if is_color(text) {
        return Some(BaseCover::Color(text.to_string()));
    }
    if let Some(url) = web(text) {
        return Some(url);
    }
    let wikilink = text.starts_with("[[") || text.starts_with("![[");
    let mut target = bare_target(text);
    if !wikilink {
        // A query or an anchor is no part of the file name, as in a Markdown image.
        target = target.split(['?', '#']).next().unwrap_or(target);
    }
    // `300` in `[[a.png|300]]` is a size, which `bare_target` has cut off.
    let spellings = [target.to_string(), percent_decode(target)];
    let as_path = || {
        spellings
            .iter()
            .filter_map(|t| relative(note, t))
            .find(|path| files.binary_search(path).is_ok())
    };
    let as_link = || spellings.iter().find_map(|t| resolver.resolve(t));
    let path = if wikilink {
        as_link().or_else(as_path)
    } else {
        as_path().or_else(as_link)
    };
    path.filter(|p| is_image(p)).map(BaseCover::Path)
}
