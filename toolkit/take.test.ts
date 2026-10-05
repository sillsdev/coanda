import { expect, test } from "vite-plus/test";
import {
  applyMarkingEdits,
  busyStretches,
  cutTime,
  findMarkingEdits,
  idleCuts,
  stillsBetween,
  takeTimeline,
} from "./take.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TakeEvents } from "./recorder.ts";

test("times after a cut move back by its length, and times inside it go to where it was", () => {
  const moved = cutTime([
    [2, 5],
    [10, 11],
  ]);
  expect([1, 2, 3, 5, 7, 10.5, 12].map(moved)).toEqual([1, 2, 2, 2, 4, 7, 8]);
});

test("still stretches are the long gaps between changes, from the start to the end", () => {
  expect(stillsBetween([1, 1.1, 4, 4.5], 10, 2)).toEqual([
    [1.1, 4],
    [4.5, 10],
  ]);
  expect(stillsBetween([], 3, 2)).toEqual([[0, 3]]);
});

test("a still stretch clear of anything busy is cut down to `keep`, on whole frames", () => {
  expect(idleCuts([[10, 16]], [], { longerThan: 2, keep: 1 })).toEqual([[10.5, 15.5]]);
  // 10.51 + 0.5 rounds up to a frame, 16.2 - 0.5 down to one.
  expect(idleCuts([[10.51, 16.2]], [])).toEqual([[11.033, 15.7]]);
});

test("busy moments split a still stretch, and short leftovers are kept", () => {
  // A key at 12 splits 10-20 into 10-11.8 (too short) and 12.2-20.
  expect(idleCuts([[10, 20]], [[12, 12]])).toEqual([[12.7, 19.5]]);
  // A narration line over the whole stretch keeps all of it.
  expect(idleCuts([[10, 20]], [[9, 21]])).toEqual([]);
  // A still stretch no longer than `longerThan` is kept.
  expect(idleCuts([[10, 12]], [])).toEqual([]);
});

const take: TakeEvents = {
  start: 1000,
  scale: 1.5,
  events: [
    { t: 1, say: "One two three." },
    { t: 4, what: "click: Add Page" },
  ],
  markings: [
    { key: "box: a", kind: "box", x: 0, y: 0, width: 10, height: 10, from: 6, to: 6.5 },
    { key: "dissolve: b", kind: "dissolve", x: 0, y: 0, width: 10, height: 10, from: 7, to: 8 },
  ],
  pointer: [{ t: 3, x: 10, y: 20 }],
  presses: [{ t: 3.5, x: 10, y: 20 }],
  keys: [9],
  secondsPerWord: 0.5,
};

test("busy stretches cover lines while spoken, actions, markings while shown, pointer and keys", () => {
  const rounded = busyStretches(take).map(([a, b]) => [a, Number(b.toFixed(3))]);
  expect(rounded).toEqual([
    [1, 2.9],
    [3, 3],
    [3.5, 3.5],
    [4, 4],
    [6, 6.85],
    [7, 8],
    [9, 9],
  ]);
});

test("the picture's timeline moves every time past the cuts and the title card", () => {
  const timeline = takeTimeline(take, [[4.5, 5.5]]);
  expect(timeline.anchors).toEqual([
    { key: "line: One two three.", t: 5.4, say: "One two three." },
    { key: "click: Add Page", t: 8.4 },
  ]);
  expect(timeline.pointer).toEqual([{ t: 7.4, x: 10, y: 20 }]);
  expect(timeline.presses).toEqual([{ t: 7.9, x: 10, y: 20 }]);
  expect(timeline.keys).toEqual([12.4]);
  // The box is kept up 2 s.
  expect(timeline.markings!.map((m) => [m.from, m.to])).toEqual([
    [9.4, 11.4],
    [10.4, 11.4],
  ]);
});

test("a take from before the pointer was logged has no pointer, presses or keys", () => {
  const { pointer, presses, keys, secondsPerWord, ...old } = take;
  void [pointer, presses, keys, secondsPerWord];
  const timeline = takeTimeline(old);
  expect([timeline.pointer, timeline.presses, timeline.keys]).toEqual([[], [], []]);
});

test("marking edits replace the logged fields, and name keys the take doesn't have", () => {
  const edited = applyMarkingEdits(take.markings, {
    "box: a": { from: 5.5, x: 3, key: "box: renamed" },
    "box: gone": { to: 1 },
  });
  expect(edited.markings[0]).toEqual({ ...take.markings[0], from: 5.5, x: 3 });
  expect(edited.markings[1]).toBe(take.markings[1]);
  expect(edited.missing).toEqual(["box: gone"]);
});

test("marking edits come from the project's video-project.json above the take", () => {
  const project = mkdtempSync(join(tmpdir(), "edits-"));
  const takeDir = join(project, "local", "takes", "t1");
  mkdirSync(takeDir, { recursive: true });
  writeFileSync(
    join(project, "video-project.json"),
    JSON.stringify({ markingEdits: { "box: a": { width: 150 } } }),
  );
  expect(findMarkingEdits(takeDir, join(project, "out.mp4"))).toEqual({
    "box: a": { width: 150 },
  });
  expect(findMarkingEdits(tmpdir(), join(tmpdir(), "out.mp4"))).toEqual({});
});
