// What the PDF export check reads from a PDF (#599): the pages and their sizes, without a tool
// that a runner may not have.
import { inflateSync } from "node:zlib";

/** The file and the text of its Flate streams (page objects may sit in object streams). */
function texts(pdf) {
  const raw = pdf.toString("latin1");
  const out = [raw];
  const stream = /stream\r?\n/gu;
  for (let match = stream.exec(raw); match; match = stream.exec(raw)) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    try {
      out.push(inflateSync(pdf.subarray(start, end)).toString("latin1"));
    } catch {
      // not a Flate stream
    }
    stream.lastIndex = end + "endstream".length;
  }
  return out;
}

export function pageCount(pdf) {
  return texts(pdf).reduce(
    (n, t) => n + (t.match(/\/Type\s*\/Page(?![A-Za-z])/gu)?.length ?? 0),
    0,
  );
}

/** The distinct `/MediaBox` rectangles as "x0 y0 x1 y1". */
export function mediaBoxes(pdf) {
  const boxes = texts(pdf).flatMap((t) =>
    Array.from(t.matchAll(/\/MediaBox\s*\[([^\]]*)\]/gu), (m) =>
      m[1].trim().split(/\s+/u).join(" "),
    ),
  );
  return [...new Set(boxes)];
}

/** True when the PDF holds an image of `width` pixels. */
export function hasImage(pdf, width) {
  const wanted = new RegExp(`\\/Width\\s+${width}(?![0-9])`, "u");
  // The dictionary of an image object holds both keys, in any order.
  return texts(pdf).some((t) =>
    (t.match(/<<[^<>]*>>/gu) ?? []).some(
      (dict) => /\/Subtype\s*\/Image(?![A-Za-z])/u.test(dict) && wanted.test(dict),
    ),
  );
}
