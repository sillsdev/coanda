import { expect, test } from "vite-plus/test";
import { placeSounds, soundFilters } from "./sounds.ts";

const press = (t: number) => ({ t, x: 10, y: 20 });

test("a click starts just before each press, and keys make typing runs split by pauses", () => {
  const placed = placeSounds({
    presses: [press(3), press(1)],
    keys: [5, 5.2, 5.4, 5.9, 7, 7.3],
  });
  expect(placed.clicks).toEqual([0.99, 2.99]);
  // 5.9 is within 0.6 s of 5.4; 7 is not, so it starts a second run.
  expect(placed.typing).toEqual([
    [5, 6.02],
    [7, 7.42],
  ]);
});

test("sounds move with the freezes", () => {
  const shift = (t: number) => (t >= 4 ? t + 2 : t);
  const placed = placeSounds({ presses: [press(3), press(4.5)], keys: [3.8, 4.1] }, shift);
  expect(placed.clicks).toEqual([2.99, 6.49]);
  // The freeze between the keys is longer than a pause in typing, so they're separate runs.
  expect(placed.typing).toEqual([
    [3.8, 3.92],
    [6.1, 6.22],
  ]);
});

test("a timeline without presses or keys has no sounds", () => {
  expect(placeSounds({})).toEqual({ clicks: [], typing: [] });
  expect(
    soundFilters({
      placement: { clicks: [], typing: [] },
      clickInput: 0,
      typingInput: 1,
      output: "[s]",
      seconds: 2,
    }),
  ).toEqual(["anullsrc=r=48000:cl=mono,atrim=duration=2.000[s]"]);
});

test("each sound is delayed to its time and mixed onto one track", () => {
  const filters = soundFilters({
    placement: { clicks: [1.5], typing: [[2, 3]] },
    clickInput: 0,
    typingInput: 1,
    output: "[s]",
    seconds: 5,
  });
  expect(filters[0]).toBe("[0:a]aresample=48000,anull[c0]");
  expect(filters[1]).toBe("[c0]volume=0.55,adelay=1500:all=1[ck0]");
  expect(filters[3]).toContain("atrim=duration=1.000");
  expect(filters[3]).toContain("adelay=2000:all=1[ty0]");
  expect(filters.at(-1)).toMatch(/^\[ck0\]\[ty0\]amix=inputs=2:.*\[s\]$/);
});
