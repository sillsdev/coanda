// Moving a time in a previous render to its place in the new render, given a render's time map.
import type { TimeSegment, Timeline } from "../shared/types.ts";

/**
 * Where time `t` of the previous render is in the new one. Inside a kept segment it moves with
 * the segment, stretched if the segment changed length. Outside every segment it was cut: it
 * goes to where the cut is, the end of the nearest kept segment before it (or the start).
 */
export function mapTime(t: number, segments: TimeSegment[]): { t: number; cut: boolean } {
  const sorted = [...segments].sort((a, b) => a.from[0] - b.from[0]);
  for (const s of sorted) {
    const [a, b] = s.from;
    if (t >= a && t <= b) {
      const [c, d] = s.to;
      const scale = b > a ? (d - c) / (b - a) : 0;
      return { t: round(c + (t - a) * scale), cut: false };
    }
  }
  const before = sorted.filter((s) => s.from[1] < t).at(-1);
  return { t: round(before ? before.to[1] : 0), cut: true };
}

/** Keeps only well-formed segments: two numbers each side, in order. */
export function validSegments(raw: unknown): TimeSegment[] {
  if (!Array.isArray(raw)) return [];
  const pair = (p: unknown): p is [number, number] =>
    Array.isArray(p) &&
    p.length === 2 &&
    p.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    (p[0] as number) <= (p[1] as number);
  return raw.filter(
    (s): s is TimeSegment =>
      typeof s === "object" &&
      s !== null &&
      pair((s as TimeSegment).from) &&
      pair((s as TimeSegment).to),
  );
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * A time map from two timelines of the same video, before and after a re-render.
 *
 * Anchors match by key, and by which occurrence of that key they are, so a repeated line or
 * action pairs up in order. Matches that would run backwards are dropped. Each stretch of the
 * old render runs from one anchor to the next, and belongs to the anchor that starts it:
 * - its anchor has a match: the stretch maps onto the new render from that match to the next
 *   anchor after it, stretched or squeezed to fit;
 * - its anchor has none (a line or action that was removed): the stretch was cut.
 * Before the first anchor (a title card) maps onto the same span in the new render, and after
 * the last anchor moves with it.
 */
export function mapFromTimelines(before: Timeline, after: Timeline): TimeSegment[] {
  const old = byTime(before.anchors);
  const now = byTime(after.anchors);
  if (!old.length || !now.length) return [];

  const occurrences = (list: { key: string }[]) => {
    const seen = new Map<string, number>();
    return list.map((a) => {
      const key = sameKey(a.key);
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      return `${key}\u0000${n}`;
    });
  };
  const oldIds = occurrences(old);
  const newIndex = new Map(occurrences(now).map((id, i) => [id, i]));
  const pairs = oldIds
    .map((id, i) => ({ i, j: newIndex.get(id) }))
    .filter((p): p is { i: number; j: number } => p.j !== undefined);
  const kept = new Map(longestIncreasing(pairs).map((p) => [p.i, p.j]));
  pairWithinGaps(kept, old.length, now.length);

  const segments: TimeSegment[] = [];
  const firstMatch = [...kept.entries()].sort((a, b) => a[0] - b[0])[0];
  if (firstMatch && firstMatch[0] === 0 && old[0].t > 0) {
    segments.push({ from: [0, old[0].t], to: [0, now[firstMatch[1]].t] });
  }
  for (let i = 0; i < old.length; i++) {
    const j = kept.get(i);
    if (j === undefined) continue;
    const start = old[i].t;
    if (i === old.length - 1 || j === now.length - 1) {
      // The last stretch, such as an end card, moves with its anchor.
      segments.push({ from: [start, start + TAIL], to: [now[j].t, now[j].t + TAIL] });
      continue;
    }
    segments.push({ from: [start, old[i + 1].t], to: [now[j].t, now[j + 1].t] });
  }
  return segments;
}

/** Keys compare without final punctuation, as recordings are matched to lines: "pages," and
 * "pages." are the same line. */
function sameKey(key: string): string {
  return key.trim().replace(/[\s.,;:!?…]+$/u, "");
}

/**
 * Between two matched anchors, an old anchor that lost its match and a new one that gained
 * none are most likely the same moment changed, such as a reworded line, so they pair up in
 * order. Only an old anchor left with nothing in its place counts as cut.
 */
function pairWithinGaps(kept: Map<number, number>, oldCount: number, newCount: number) {
  const matched = [...kept.entries()].sort((a, b) => a[0] - b[0]);
  const bounds = [[-1, -1], ...matched, [oldCount, newCount]];
  for (let g = 0; g + 1 < bounds.length; g++) {
    const [i0, j0] = bounds[g];
    const [i1, j1] = bounds[g + 1];
    const n = Math.min(i1 - i0 - 1, j1 - j0 - 1);
    for (let k = 1; k <= n; k++) kept.set(i0 + k, j0 + k);
  }
}

/** Far enough past the last anchor to cover the end of any video. */
const TAIL = 100000;

function byTime(anchors: Timeline["anchors"]) {
  return anchors
    .filter((a) => typeof a?.key === "string" && typeof a?.t === "number" && Number.isFinite(a.t))
    .sort((a, b) => a.t - b.t);
}

/** The longest run of pairs whose j increases with i (pairs arrive sorted by i). */
function longestIncreasing<T extends { j: number }>(pairs: T[]): T[] {
  const tails: number[] = [];
  const prev: number[] = new Array<number>(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]].j < pairs[k].j) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const out: T[] = [];
  for (let k = tails.at(-1) ?? -1; k >= 0; k = prev[k]) out.unshift(pairs[k]);
  return out;
}
