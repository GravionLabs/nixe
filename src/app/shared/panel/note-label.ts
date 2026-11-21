/** Splits a vault path into the note title (no `.md`) and the folder behind it. */
export function noteLabel(path: string): { title: string; folder: string } {
  const slash = path.lastIndexOf("/");
  const file = slash < 0 ? path : path.slice(slash + 1);
  return {
    title: file.replace(/\.md$/i, ""),
    folder: slash < 0 ? "" : path.slice(0, slash),
  };
}
