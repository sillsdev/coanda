import { describe, expect, test } from "vite-plus/test";
import type { Marking, PointerSample, Timeline } from "../shared/types.ts";
import {
  actions,
  boxDurations,
  boxesCross,
  boxesLeaveTogether,
  boxesOffFrame,
  checkClickReactions,
  glideStops,
  matchWords,
  normalizeWord,
  pointerJumps,
  sayThenShow,
  spokenLines,
  type SpokenLine,
} from "./checks.ts";

const box = (key: string, from: number, to: number): Marking => ({
  key,
  kind: "box",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  from,
  to,
});

/** A pointer moving from (x0, y0) to (x1, y1) between t0 and t1, a sample every 1/60 s. */
const glide = (t0: number, t1: number, x0: number, y0: number, x1: number, y1: number) => {
  const n = Math.round((t1 - t0) * 60);
  return Array.from({ length: n + 1 }, (_, i) => ({
    t: t0 + (t1 - t0) * (i / n),
    x: x0 + (x1 - x0) * (i / n),
    y: y0 + (y1 - y0) * (i / n),
  }));
};

const line = (text: string, at: number, seconds: number): SpokenLine => ({
  key: `line: ${text}`,
  text,
  at,
  seconds,
});

test("narration lines come from the voice report, or from the timeline at a pace per word", () => {
  const timeline: Timeline = {
    anchors: [
      { key: "line: Two words.", t: 3, say: "Two words." },
      { key: "click: OK", t: 2 },
      { key: "line: One.", t: 1, say: "One." },
    ],
  };
  expect(spokenLines(timeline, undefined, 0.5)).toEqual([
    { key: "line: One.", text: "One.", at: 1, seconds: 0.5 },
    { key: "line: Two words.", text: "Two words.", at: 3, seconds: 1 },
  ]);
  const report = {
    picture: "p.mp4",
    lines: [{ key: "line: One.", text: "One.", at: 1.2, seconds: 0.8, recording: "a.mp3" }],
    holds: [],
    unvoiced: [],
    silent: false,
  };
  expect(spokenLines(timeline, report)).toEqual([
    { key: "line: One.", text: "One.", at: 1.2, seconds: 0.8 },
  ]);
});

test("actions are clicks, stretches of typing and of pointer movement", () => {
  const timeline: Timeline = {
    anchors: [{ key: "click: OK", t: 5 }],
    presses: [{ t: 5, x: 100, y: 100 }],
    keys: [7, 7.2, 7.5, 9],
    pointer: [{ t: 0, x: 0, y: 0 }, ...glide(4, 4.9, 0, 0, 100, 100), { t: 6, x: 100, y: 100 }],
  };
  expect(actions(timeline)).toEqual([
    { what: "pointer moving", from: 4, to: 4.9 },
    { what: "click", from: 5, to: 5 },
    { what: "typing", from: 7, to: 7.5 },
    { what: "typing", from: 9, to: 9 },
  ]);
});

test("a timeline without clicks or pointer gives its logged actions", () => {
  expect(
    actions({
      anchors: [
        { key: "line: Hi.", t: 0, say: "Hi." },
        { key: "click: OK", t: 2 },
      ],
    }),
  ).toEqual([{ what: "click: OK", from: 2, to: 2 }]);
});

test("say it, then show it: narration over an action, and no beat before one", () => {
  const lines = [line("Click OK.", 1, 1), line("Now type.", 3, 1.5), line("All done.", 8, 2)];
  const findings = sayThenShow(
    lines,
    [
      // Starts 0.1 s after "Click OK." ends.
      { what: "click", from: 2.1, to: 2.1 },
      // "Now type." is still being said.
      { what: "typing", from: 4, to: 5 },
      // Well after; the wrap-up plays over the last move, which is allowed.
      { what: "pointer moving", from: 9, to: 9.5 },
    ],
    { sayDuring: ["All done."] },
  );
  expect(findings.map((f) => [f.check, f.t])).toEqual([
    ["say-then-show", 2.1],
    ["say-then-show", 4],
  ]);
  expect(findings[0].message).toContain("0.10 s after");
  expect(findings[1].message).toContain("plays over typing");
});

test("a click while a line is being said is narration over an action", () => {
  const [f] = sayThenShow([line("Click it.", 1, 2)], [{ what: "click", from: 2, to: 2 }]);
  expect(f.message).toContain("still being said at click");
});

test("boxes shorter than 2 s, allowing a frame of rounding", () => {
  const findings = boxDurations([box("a", 1, 3), box("b", 5, 6.98), box("c", 10, 11.2)]);
  expect(findings.map((f) => f.t)).toEqual([10]);
});

test("boxes shown together must leave together", () => {
  const findings = boxesLeaveTogether([
    // A group that leaves together, after a staggered start.
    box("g1", 1, 4),
    box("g2", 1.05, 4),
    box("g3", 1.1, 4.05),
    // One box after another: not shown together.
    box("s1", 5, 7),
    box("s2", 7.02, 9),
    // Shown together, then one stays on.
    box("p", 10, 12),
    box("q", 10.5, 14),
  ]);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ check: "boxes-leave-together", t: 12 });
});

test("the screen must react at least 0.3 s after a click", () => {
  const findings = checkClickReactions([
    { t: 1, reaction: 0.1 },
    { t: 3, reaction: 0.45 },
    { t: 5, reaction: null },
  ]);
  expect(findings.map((f) => f.t)).toEqual([1]);
});

test("a pointer jump stands out from the steps around it; a fast glide doesn't", () => {
  const smooth = glide(0, 0.5, 0, 0, 1500, 0);
  expect(pointerJumps(smooth)).toEqual([]);
  const jumpy: PointerSample[] = [
    ...glide(0, 0.5, 0, 0, 100, 0),
    { t: 2, x: 100, y: 0 },
    { t: 2.016, x: 600, y: 300 },
    { t: 3, x: 600, y: 300 },
  ];
  const findings = pointerJumps(jumpy);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ check: "pointer-jump", t: 2.016 });
});

test("a stop in the middle of a glide is found, unless there's a click in it or it turns", () => {
  // Moves right, stalls for half a second, then carries on right.
  const stalled = [...glide(1, 1.5, 0, 0, 300, 0), ...glide(2, 2.5, 300, 0, 600, 0)];
  expect(glideStops(stalled).map((f) => f.check)).toEqual(["glide-stop"]);
  expect(glideStops(stalled, [1.7])).toEqual([]);
  // Moves right, rests, then goes down: two moves, not one.
  const turned = [...glide(1, 1.5, 0, 0, 300, 0), ...glide(2, 2.5, 300, 0, 300, 300)];
  expect(glideStops(turned)).toEqual([]);
  // A long rest is a pause, not a stall.
  const rested = [...glide(1, 1.5, 0, 0, 300, 0), ...glide(4, 4.5, 300, 0, 600, 0)];
  expect(glideStops(rested)).toEqual([]);
});

test("words are compared without case, punctuation or spelled-out numbers", () => {
  expect(normalizeWord("“Make")).toBe("make");
  expect(normalizeWord("don’t,")).toBe("don't");
  expect(normalizeWord("Three")).toBe("3");
});

test("every script word must be heard once, in order, inside its own line", () => {
  const lines = [line("Click Add Page.", 1, 1.5), line("Then type three words.", 4, 2)];
  const heard = (spec: [string, number][]) =>
    spec.map(([text, start]) => ({ text, start, end: start + 0.3 }));
  expect(
    matchWords(
      lines,
      heard([
        ["click", 1],
        ["add", 1.4],
        ["page.", 1.8],
        ["Then", 4],
        ["type", 4.3],
        ["3", 4.7],
        ["words", 5.1],
      ]),
    ),
  ).toEqual([]);

  const findings = matchWords(
    lines,
    heard([
      ["click", 1],
      ["add", 1.4],
      // "Page" is heard after its line has ended.
      ["page", 3],
      ["then", 4],
      ["um", 4.2],
      // "type" is missing.
      ["three", 4.7],
      ["word", 5.1],
    ]),
    [["words", "word"]],
  );
  expect(findings.map((f) => f.message)).toEqual([
    `"page" of "Click Add Page." is heard at 3.00-3.30 s, outside its line (1.00-2.50 s)`,
    `"type" of "Then type three words." is not heard`,
    `"um" is heard at 4.20 s but isn't in the script there`,
  ]);
});

describe("boxesCross and boxesOffFrame", () => {
  const box = (key: string, x: number, y: number, w: number, h: number, from = 0, to = 3) => ({
    key,
    kind: "box" as const,
    x,
    y,
    width: w,
    height: h,
    from,
    to,
  });

  test("boxes that cross at the same time are found; nested or apart ones aren't", () => {
    const found = boxesCross([
      box("a", 0, 0, 100, 100),
      box("b", 50, 50, 100, 100),
      box("inner", 10, 10, 20, 20),
      box("apart", 500, 500, 10, 10),
      box("later", 60, 60, 100, 100, 5, 8),
    ]);
    expect(found.map((f) => f.message)).toEqual([
      "a and b are shown at the same time and overlap, neither inside the other",
    ]);
  });

  test("a box past the edge of the frame is found", () => {
    const found = boxesOffFrame([box("left", -4, 10, 50, 50), box("in", 0, 0, 50, 50)], {
      width: 1536,
      height: 1152,
    });
    expect(found.map((f) => f.check + " " + f.t)).toEqual(["box-off-frame 0"]);
  });
});
