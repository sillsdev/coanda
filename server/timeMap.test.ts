import { expect, test } from "vite-plus/test";
import { mapFromTimelines, mapTime, validSegments } from "./timeMap.ts";

// 0–124 kept as is; 124–131 cut; 131–311 kept, now 7 s earlier; 311–390 cut (end).
const map = [
  { from: [0, 124] as [number, number], to: [0, 124] as [number, number] },
  { from: [131, 311] as [number, number], to: [124, 304] as [number, number] },
];

test("a time in a kept stretch moves with it", () => {
  expect(mapTime(60, map)).toEqual({ t: 60, cut: false });
  expect(mapTime(158.4, map)).toEqual({ t: 151.4, cut: false });
});

test("a time in a cut goes to the cut point", () => {
  expect(mapTime(128.7, map)).toEqual({ t: 124, cut: true });
  expect(mapTime(350, map)).toEqual({ t: 304, cut: true });
});

test("a stretched segment stretches the times in it", () => {
  const slower = [{ from: [10, 20] as [number, number], to: [10, 30] as [number, number] }];
  expect(mapTime(15, slower)).toEqual({ t: 20, cut: false });
});

test("malformed segments are dropped", () => {
  expect(validSegments([{ from: [5, 1], to: [0, 1] }, { from: [0, 1] }, null, "x"])).toEqual([]);
  expect(validSegments(map)).toEqual(map);
});

test("timelines: a removed line is cut, later moments move, a re-paced stretch fits", () => {
  const before = {
    anchors: [
      { key: "line: Welcome.", t: 4.4 },
      { key: "click: Add Page", t: 10 },
      { key: "click: Add Page", t: 12 },
      { key: "line: The flower is not printed.", t: 20 },
      { key: "line: Now the credits.", t: 25 },
    ],
  };
  const after = {
    anchors: [
      { key: "line: Welcome.", t: 4.4 },
      { key: "click: Add Page", t: 10 },
      { key: "click: Add Page", t: 13 },
      { key: "line: Now the credits.", t: 21 },
    ],
  };
  const map = mapFromTimelines(before, after);
  // The title card stays put.
  expect(mapTime(2, map)).toEqual({ t: 2, cut: false });
  // Between the two Add Page clicks, which now take 3 s instead of 2: placed proportionally.
  expect(mapTime(11, map)).toEqual({ t: 11.5, cut: false });
  // The removed line's stretch is cut, to where the cut is.
  expect(mapTime(22, map).cut).toBe(true);
  // After it, everything moves with "Now the credits."
  expect(mapTime(30, map)).toEqual({ t: 26, cut: false });
});

test("timelines: a reworded line keeps its notes, and final punctuation doesn't matter", () => {
  const before = {
    anchors: [
      { key: "line: Welcome.", t: 0 },
      { key: "line: If you don't add a picture, the space stays empty.", t: 5 },
      { key: "line: We typed on the pages,", t: 10 },
    ],
  };
  const after = {
    anchors: [
      { key: "line: Welcome.", t: 0 },
      { key: "line: This flower is an image placeholder.", t: 5 },
      { key: "line: We typed on the pages.", t: 9 },
    ],
  };
  const map = mapFromTimelines(before, after);
  // The reworded line pairs with its replacement: its notes stay with that stretch, not cut.
  expect(mapTime(7.5, map)).toEqual({ t: 7, cut: false });
  // "pages," and "pages." are the same line.
  expect(mapTime(12, map)).toEqual({ t: 11, cut: false });
});

test("timelines: notes on a removed ending are cut", () => {
  const before = {
    anchors: [
      { key: "intro", t: 0 },
      { key: "summary", t: 10 },
      { key: "credits", t: 20 },
    ],
  };
  const after = {
    anchors: [
      { key: "intro", t: 0 },
      { key: "summary", t: 10 },
    ],
  };
  const map = mapFromTimelines(before, after);
  expect(mapTime(15, map)).toEqual({ t: 15, cut: false });
  expect(mapTime(22, map)).toEqual({ t: 20, cut: true });
});

test("timelines: an inserted moment doesn't stretch the notes before it over itself", () => {
  const before = {
    anchors: [
      { key: "a", t: 0 },
      { key: "b", t: 10 },
    ],
  };
  const after = {
    anchors: [
      { key: "a", t: 0 },
      { key: "new", t: 10 },
      { key: "b", t: 14 },
    ],
  };
  const map = mapFromTimelines(before, after);
  // a's old stretch 0–10 maps to new a up to the inserted anchor, 0–10, not 0–14.
  expect(mapTime(5, map)).toEqual({ t: 5, cut: false });
  expect(mapTime(12, map)).toEqual({ t: 16, cut: false });
});
