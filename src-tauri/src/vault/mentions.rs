//! Unlinked mentions (#235): places where a note's title or alias stands in plain text, and the
//! edit that turns one into a `[[link]]`. Code blocks, code spans, comments, frontmatter and
//! existing links never count.

use serde::Serialize;

use super::meta::prose_lines;

/// One occurrence of a term in the prose of a note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Mention {
    /// 1-based line.
    pub line: usize,
    /// Byte range of the match in that line.
    pub start: usize,
    pub end: usize,
    /// The trimmed line.
    pub context: String,
    /// The text as written in the note.
    pub text: String,
}

fn is_word(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_alphanumeric() || c == '_')
}

/// The whole-word, case-insensitive occurrences of any of `terms` in `text`; at one position the
/// longest term wins. Sorted by position.
pub fn find(text: &str, terms: &[String]) -> Vec<Mention> {
    let mut terms: Vec<String> = terms
        .iter()
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    terms.sort_by_key(|t| std::cmp::Reverse(t.len()));
    terms.dedup();
    let original: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    for (number, prose) in prose_lines(text) {
        // Lowercasing can change the width of a char; search per char instead of per string.
        let chars: Vec<(usize, char)> = prose.char_indices().collect();
        let lower: Vec<char> = chars
            .iter()
            .map(|(_, c)| c.to_lowercase().next().unwrap_or(*c))
            .collect();
        let mut i = 0;
        'scan: while i < chars.len() {
            for term in &terms {
                let t: Vec<char> = term.chars().collect();
                if lower.len() - i < t.len() || lower[i..i + t.len()] != t[..] {
                    continue;
                }
                let before = i.checked_sub(1).map(|p| chars[p].1);
                let after = chars.get(i + t.len()).map(|(_, c)| *c);
                if is_word(before) || is_word(after) {
                    continue;
                }
                let start = chars[i].0;
                let end = chars.get(i + t.len()).map_or(prose.len(), |(at, _)| *at);
                let line = original.get(number - 1).copied().unwrap_or("");
                out.push(Mention {
                    line: number,
                    start,
                    end,
                    context: line
                        .trim()
                        .trim_start_matches('\u{feff}')
                        .chars()
                        .take(200)
                        .collect(),
                    text: line.get(start..end).unwrap_or("").to_string(),
                });
                i += t.len();
                continue 'scan;
            }
            i += 1;
        }
    }
    out
}

/// `text` with the mention at `line`/`start..end` replaced by a wikilink to `title`. `None` when
/// the line no longer holds `expected` there (the note changed since the mention was listed).
pub fn link(
    text: &str,
    line: usize,
    start: usize,
    end: usize,
    expected: &str,
    title: &str,
) -> Option<String> {
    let mut at = 0;
    for (n, raw) in text.split_inclusive('\n').enumerate() {
        if n + 1 == line {
            let found = raw.get(start..end)?;
            if found != expected {
                return None;
            }
            let link = if found == title {
                format!("[[{title}]]")
            } else {
                format!("[[{title}|{found}]]")
            };
            return Some(format!(
                "{}{}{}",
                &text[..at + start],
                link,
                &text[at + end..]
            ));
        }
        at += raw.len();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terms(t: &[&str]) -> Vec<String> {
        t.iter().map(|s| s.to_string()).collect()
    }

    fn lines(text: &str, t: &[&str]) -> Vec<usize> {
        find(text, &terms(t)).iter().map(|m| m.line).collect()
    }

    #[test]
    fn finds_a_plain_mention_with_its_line_and_text() {
        let found = find(
            "one\nSee the Project Plan here\n",
            &terms(&["project plan"]),
        );
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].line, 2);
        assert_eq!(found[0].text, "Project Plan");
        assert_eq!(found[0].context, "See the Project Plan here");
        assert_eq!(
            &"See the Project Plan here"[found[0].start..found[0].end],
            "Project Plan"
        );
    }

    #[test]
    fn finds_an_alias_and_prefers_the_longest_term() {
        let found = find("a PP and Plan B\n", &terms(&["Plan", "Plan B", "PP"]));
        let texts: Vec<_> = found.iter().map(|m| m.text.as_str()).collect();
        assert_eq!(texts, ["PP", "Plan B"]);
    }

    #[test]
    fn needs_whole_words() {
        assert!(lines("replanning plans planned\n", &["plan"]).is_empty());
        assert_eq!(lines("plan, plan.\n", &["plan"]), [1, 1]);
    }

    #[test]
    fn skips_links_code_comments_and_frontmatter() {
        let text = "---\ntitle: plan\n---\n[[plan]] [x](plan.md) [plan](other.md) ![[plan]]\n`plan`\n```\nplan\n```\n%% plan %%\nreal plan\n";
        assert_eq!(lines(text, &["plan"]), [10]);
    }

    #[test]
    fn counts_the_lines_of_a_note_with_frontmatter() {
        assert_eq!(lines("---\na: 1\n---\nplan\n", &["plan"]), [4]);
    }

    #[test]
    fn byte_offsets_survive_wide_chars_before_a_mention() {
        let line = "`é` ün plan";
        let found = find(&format!("{line}\n"), &terms(&["plan"]));
        assert_eq!(&line[found[0].start..found[0].end], "plan");
    }

    #[test]
    fn a_term_with_wide_chars_matches() {
        assert_eq!(lines("Straße Äpfel\n", &["äpfel"]), [1]);
    }

    #[test]
    fn links_with_the_title_or_with_the_written_text() {
        let text = "a\nsee Plan now\n";
        let m = &find(text, &terms(&["plan"]))[0];
        assert_eq!(
            link(text, m.line, m.start, m.end, &m.text, "Plan").unwrap(),
            "a\nsee [[Plan]] now\n"
        );
        let m = &find("see plan now\n", &terms(&["plan"]))[0];
        assert_eq!(
            link("see plan now\n", 1, m.start, m.end, "plan", "Plan").unwrap(),
            "see [[Plan|plan]] now\n"
        );
    }

    #[test]
    fn refuses_a_link_when_the_note_changed() {
        assert!(link("see plan\n", 1, 4, 8, "task", "Plan").is_none());
        assert!(link("see plan\n", 5, 4, 8, "plan", "Plan").is_none());
        assert!(link("see plan\n", 1, 4, 99, "plan", "Plan").is_none());
    }

    #[test]
    fn keeps_crlf_line_ends() {
        assert_eq!(
            link("see plan\r\nnext\r\n", 1, 4, 8, "plan", "Plan").unwrap(),
            "see [[Plan|plan]]\r\nnext\r\n"
        );
    }
}
