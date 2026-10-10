// JSON highlighting as Code Example lines (adapted from the defuss-dataview site): one <span> per line, keys and strings
// in the block's own token classes (.mk-code-block-k, .mk-code-block-s), numbers and literals in .wr-json-literal.
// The CRDT explorer on the landing page and the demo's CRDT inspector both render through it, so JSON looks alike in both.
// Text goes in through textContent only: the JSON may hold anything a user or a remote peer typed.
// One regex for one grammar beats a highlighting library (Prism, highlight.js), which would be the pages' only
// dependency besides defuss-shadcn. VERIFIED: e2e/browser/site.spec.mjs finds the token classes in the explorer.
const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** The lines of a JSON text as highlighted <span> elements; an empty line keeps its height. */
export function jsonLines(text) {
  return text.split("\n").map((source) => {
    const line = document.createElement("span");
    let last = 0;
    for (const match of source.matchAll(TOKEN)) {
      if (match.index > last) line.append(source.slice(last, match.index));
      const token = document.createElement("span");
      token.className = match[1] ? (match[2] ? "mk-code-block-k" : "mk-code-block-s") : "wr-json-literal";
      token.textContent = match[1] ?? match[0];
      line.append(token);
      if (match[2]) line.append(match[2]);
      last = match.index + match[0].length;
    }
    line.append(source.slice(last) || (last ? "" : " "));
    return line;
  });
}
