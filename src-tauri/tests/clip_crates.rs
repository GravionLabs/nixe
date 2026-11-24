//! Smoke test of the crates for clipping web pages (#501, Feature #499): the Readability port
//! extracts the article of a page, and the HTML→Markdown converter turns it into Markdown.
//! The clip logic itself follows in #502.

use dom_smoothie::{Config, Readability};

const PAGE: &str = include_str!("fixtures/clip-article.html");
const URL: &str = "https://example.com/exercise/cable-standing-fly/";

fn article() -> dom_smoothie::Article {
    let url = tauri::Url::parse(URL).expect("a valid URL");
    let mut readability = Readability::new(PAGE, Some(url.as_str()), Some(Config::default()))
        .expect("the page parses");
    readability.parse().expect("the page has an article")
}

#[test]
fn readability_keeps_the_article_and_drops_the_chrome() {
    let article = article();
    assert!(
        article.title.contains("Cable Standing Fly"),
        "title: {}",
        article.title
    );
    let html = article.content.to_string();
    assert!(html.contains("constant tension"));
    assert!(!html.contains("Log in"), "navigation is dropped");
    assert!(!html.contains("Deadlift"), "the sidebar is dropped");
    assert!(!html.contains("tracking"), "scripts are dropped");
}

#[test]
fn the_article_converts_to_markdown() {
    let markdown = htmd::convert(&article().content).expect("the article converts");
    assert!(markdown.contains("## How to do it"), "{markdown}");
    assert!(
        markdown.contains("**twelve clean repetitions**"),
        "{markdown}"
    );
    assert!(
        markdown.contains("[chest training guide](https://example.com/chest-guide)"),
        "{markdown}"
    );
    assert!(
        markdown
            .lines()
            .any(|line| line.starts_with("1.") && line.contains("Step forward")),
        "an ordered list: {markdown}"
    );
}
