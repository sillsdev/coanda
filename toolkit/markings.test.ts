import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import type { Marking } from "../shared/types.ts";
import {
  DEFAULT_MARKING_STYLE,
  arrowImage,
  arrowPlace,
  boxImage,
  frameBefore,
  markingFilters,
  settleBoxes,
} from "./markings.ts";

const box = (key: string, from: number, to: number, extra: Partial<Marking> = {}): Marking => ({
  key,
  kind: "box",
  x: 100,
  y: 50,
  width: 200,
  height: 80,
  from,
  to,
  ...extra,
});

test("a box shown too briefly stays up 2 s", () => {
  expect(settleBoxes([box("a", 10, 10.5)])[0].to).toBe(12);
  expect(settleBoxes([box("a", 10, 15)])[0].to).toBe(15);
});

test("boxes on screen together that end close together leave together", () => {
  const settled = settleBoxes([
    box("a", 10, 13),
    box("b", 10.1, 13.3),
    box("c", 10.2, 13.45),
    // On screen with them, but ends much later.
    box("e", 11, 20),
  ]);
  expect(settled.map((m) => m.to)).toEqual([13.45, 13.45, 13.45, 20]);
});

test("a box that ends close to another but was never on screen with it keeps its end", () => {
  const settled = settleBoxes([box("a", 10, 13), box("b", 13.1, 13.3)], 0);
  expect(settled.map((m) => m.to)).toEqual([13, 13.3]);
});

test("dissolves are not settled", () => {
  const d: Marking = { ...box("d", 5, 5.8), kind: "dissolve" };
  expect(settleBoxes([d])[0]).toEqual(d);
});

test("a box image reaches past the box by its margin", () => {
  const style = { ...DEFAULT_MARKING_STYLE, scale: 1.5 };
  const image = boxImage(box("a", 0, 1), style);
  expect(image.width).toBe(200 + 2 * image.margin);
  expect(image.height).toBe(80 + 2 * image.margin);
  expect(image.png.subarray(1, 4).toString("ascii")).toBe("PNG");
});

test("an arrow image lies along the way it points", () => {
  const style = { ...DEFAULT_MARKING_STYLE, scale: 1.5, glow: 0 };
  const across = arrowImage("left", style);
  // 64 x 40 layout pixels at 1.5, plus a 2 px margin each side.
  expect([across.width, across.height]).toEqual([100, 64]);
  expect([across.tipX, across.tipY]).toEqual([98, 32]);
  const down = arrowImage("above", style);
  expect([down.width, down.height]).toEqual([64, 100]);
  expect([down.tipX, down.tipY]).toEqual([32, 98]);
  const up = arrowImage("below", style);
  expect([up.tipX, up.tipY]).toEqual([32, 2]);
});

test("an arrow's tip stands off the box by its gap, on its side", () => {
  const style = { ...DEFAULT_MARKING_STYLE, scale: 1.5, glow: 0 };
  const m = box("a", 0, 1, { kind: "arrow" });
  const tip = (side: Marking["side"]) => {
    const image = arrowImage(side!, style);
    const at = arrowPlace({ ...m, side }, style, image);
    return [at.x + image.tipX, at.y + image.tipY, at.dx, at.dy];
  };
  // The box is x 100-300, y 50-130; the gap is 8 x 1.5 = 12.
  expect(tip("left")).toEqual([88, 90, 1, 0]);
  expect(tip("right")).toEqual([312, 90, -1, 0]);
  expect(tip("above")).toEqual([200, 38, 0, 1]);
  expect(tip("below")).toEqual([200, 142, 0, -1]);
});

test("the frame before a time is the one showing just before it", () => {
  // At 30 fps the frame showing just before 10 s is the one at 9.9667 s.
  expect(frameBefore(10)).toBe(9.963);
  expect(frameBefore(10.01)).toBe(9.996);
  expect(frameBefore(0)).toBe(0);
});

test("marking filters put dissolves first, and each marking takes one input", () => {
  const dir = mkdtempSync(join(tmpdir(), "markings-"));
  const markings: Marking[] = [
    box("a", 5, 7),
    { ...box("b", 6, 8), kind: "arrow", side: "right" },
    { ...box("c", 9, 9.8), kind: "dissolve" },
  ];
  const { inputs, filters } = markingFilters({
    markings,
    style: { scale: 1.5 },
    dir,
    name: "draft",
    input: "[0:v]",
    output: "[marked]",
    firstInput: 3,
    picture: "picture.mp4",
  });
  expect(inputs.filter((a) => a === "-i")).toHaveLength(3);
  expect(inputs.slice(0, 6)).toEqual(["-ss", "8.963", "-t", "1", "-i", "picture.mp4"]);
  expect(filters[0]).toMatch(
    /^\[3:v\]trim=end_frame=1,.*crop=w='min\(200,iw\)'.*fade=t=out:st=0:d=0\.800:alpha=1,setpts=PTS-STARTPTS\+9\/TB\[ds2\]$/,
  );
  expect(filters[1]).toBe(
    "[0:v][ds2]overlay=x='min(100,W-w)':y='min(50,H-h)':eof_action=pass[mk2]",
  );
  expect(filters[2]).toMatch(/^\[4:v\]format=rgba,fade=t=in/);
  expect(filters[3]).toMatch(/^\[mk2\]\[box0\]overlay=/);
  expect(filters[4]).toMatch(/^\[5:v\]format=rgba,fade=t=in.*setpts=PTS-STARTPTS\+6\/TB\[ar1\]$/);
  // Pointing left from the box's right side, it slides in from further right.
  expect(filters[5]).toMatch(
    /^\[mk0\]\[ar1\]overlay=x='\d+\+51\.0\*pow\(1-clip\(\(t-6\)\/0\.35,0,1\),2\)':y='\d+':eof_action=pass:eval=frame\[marked\]$/,
  );
});

test("a dissolve without the picture is an error", () => {
  expect(() =>
    markingFilters({
      markings: [{ ...box("c", 9, 9.8), kind: "dissolve" }],
      style: undefined,
      dir: tmpdir(),
      name: "x",
      input: "[0:v]",
      output: "[o]",
      firstInput: 1,
    }),
  ).toThrow(/needs the picture/);
});
