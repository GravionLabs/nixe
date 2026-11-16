import type { MarkdownIt } from "markdown-it";

import { splitFrontmatter } from "./frontmatter";
import { frontmatterTags, renderPropertiesHtml, toProperties, type Property } from "./properties";

export interface RenderedNote {
  /** Properties panel (and warning) followed by the body; NOT sanitized. */
  html: string;
  properties: Property[];
  /** Frontmatter and inline tags, unique, without the leading `#`. */
  tags: string[];
  /** YAML error message, if the frontmatter was invalid. */
  frontmatterError: string | null;
}

export function renderNote(
  md: MarkdownIt,
  text: string,
  vaultFiles?: readonly string[],
  vaultRoot?: string,
): RenderedNote {
  const fm = splitFrontmatter(text);
  const env: { tags?: string[]; vaultFiles?: readonly string[]; vaultRoot?: string } = {
    vaultFiles,
    vaultRoot,
  };
  const body = md.render(fm.body, env);
  const properties = toProperties(fm.data);
  const tags = [...new Set([...frontmatterTags(fm.data), ...(env.tags ?? [])])];
  return {
    html: renderPropertiesHtml(properties, fm.error) + body,
    properties,
    tags,
    frontmatterError: fm.error,
  };
}
