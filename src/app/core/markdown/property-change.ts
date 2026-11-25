import { splitFrontmatter } from "./frontmatter";
import { editFrontmatter } from "./frontmatter-edit";

/** The new value of a property, made from the one the note holds now (`undefined`: none). */
export type PropertyChange = (current: unknown) => unknown;

/**
 * Applies `change` to the property `name` of the note text. The exact key wins over one that
 * differs in case only, as in a base. `value` is what the property holds afterwards; the text is
 * the same when the value does not change. Throws when the frontmatter cannot be changed.
 */
export function changeProperty(
  text: string,
  name: string,
  change: PropertyChange,
): { text: string; value: unknown } {
  const { data, error } = splitFrontmatter(text);
  if (error) throw new Error(`Invalid frontmatter: ${error}`);
  const keys = Object.keys(data);
  const wanted = name.toLowerCase();
  const key = keys.includes(name) ? name : (keys.find((k) => k.toLowerCase() === wanted) ?? name);
  const current = Object.hasOwn(data, key) ? data[key] : undefined;
  const value = change(current);
  if (value === undefined || JSON.stringify(value) === JSON.stringify(current))
    return { text, value: current };
  return { text: editFrontmatter(text, { kind: "set", key, value }), value };
}
