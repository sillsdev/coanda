// Comments on a document remember the passage they're on by quoting it, with a little of the
// text before and after (the W3C Web Annotation TextQuoteSelector), so they stay on their
// passage when the document is edited around them. Positions here are character offsets into
// the document as displayed: the text of the rendered page, without Markdown markup.
import type { TextQuote } from "../shared/types.ts";

/** How much text before and after a passage is kept to tell repeats apart. */
const CONTEXT = 32;

/** The quote for the passage between `start` and `end` of `text`. */
export function quoteAt(text: string, start: number, end: number): TextQuote {
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
  };
}

/**
 * Where a quote is in `text` now: of the places its words appear, the one whose surroundings
 * best match the quote's. Null when the words no longer appear at all.
 */
export function findQuote(text: string, quote: TextQuote): { start: number; end: number } | null {
  if (!quote.exact) return null;
  let best: { start: number; score: number } | null = null;
  for (let i = text.indexOf(quote.exact); i >= 0; i = text.indexOf(quote.exact, i + 1)) {
    const before = text.slice(Math.max(0, i - quote.prefix.length), i);
    const after = text.slice(i + quote.exact.length, i + quote.exact.length + quote.suffix.length);
    const score = sameEnd(before, quote.prefix) + sameStart(after, quote.suffix);
    if (!best || score > best.score) best = { start: i, score };
  }
  return best && { start: best.start, end: best.start + quote.exact.length };
}

/** How many characters two strings share at their ends. */
function sameEnd(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** How many characters two strings share at their starts. */
function sameStart(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** The character offsets of a DOM range within `container`'s text. */
export function rangeOffsets(container: Node, range: Range): { start: number; end: number } {
  const before = document.createRange();
  before.selectNodeContents(container);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  return { start, end: start + range.toString().length };
}

/** A DOM range over the characters between `start` and `end` of `container`'s text. */
export function rangeAt(container: Node, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let pos = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = node.textContent?.length ?? 0;
    if (!started && start <= pos + len) {
      range.setStart(node, start - pos);
      started = true;
    }
    if (started && end <= pos + len) {
      range.setEnd(node, end - pos);
      return range;
    }
    pos += len;
  }
  return null;
}
