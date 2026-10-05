import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import type { Timeline } from "../shared/types.ts";
import { clickReactions } from "./checks.ts";
import { ffmpeg, imageSize } from "./ffmpeg.ts";
import {
  anchorTimes,
  audioLevels,
  contactSheet,
  parseCrop,
  parseLevels,
  screenChanges,
  summarize,
} from "./measure.ts";

const timeline: Timeline = {
  anchors: [
    { key: "line: Click Add Page.", t: 1, say: "Click Add Page." },
    { key: "click: Add Page", t: 3.5 },
    { key: "end", t: 9 },
  ],
  markings: [{ key: "box: add", kind: "box", x: 1, y: 2, width: 30, height: 40, from: 2, to: 4 }],
};

/** A 2 s video, 192x108 at 30 fps: black for the first second, then white, with a tone from
 * 0.5 s. */
function blackThenWhite(): string {
  const dir = mkdtempSync(join(tmpdir(), "howreel-measure-"));
  const video = join(dir, "bw.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=black:s=192x108:r=30:d=1",
    "-f",
    "lavfi",
    "-i",
    "color=white:s=192x108:r=30:d=1",
    "-f",
    "lavfi",
    "-i",
    "sine=f=440:d=1.5:sample_rate=48000",
    "-filter_complex",
    "[0][1]concat=n=2:v=1:a=0,format=yuv420p[v];[2]adelay=500:all=1,apad=whole_dur=2[a]",
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-t",
    "2",
    video,
  ]);
  return video;
}

test("anchor specs give times: a key or the start of one, with an offset", () => {
  expect(
    anchorTimes(timeline, ["click: Add Page+0.3", "end-1", "box: add", "line: Click", "2.5"]),
  ).toEqual([
    { t: 3.8, label: "click: Add Page+0.3" },
    { t: 8, label: "end-1" },
    { t: 2, label: "box: add" },
    { t: 1, label: "line: Click" },
    { t: 2.5, label: "" },
  ]);
  expect(() => anchorTimes(timeline, ["nothing"])).toThrow(/No anchor/);
});

test("a crop is written w:h:x:y", () => {
  expect(parseCrop("600:400:100:50")).toEqual({ x: 100, y: 50, width: 600, height: 400 });
  expect(() => parseCrop("600x400")).toThrow();
});

test("audio levels are read from ametadata's print-out", () => {
  const text = [
    "frame:0    pts:0       pts_time:0",
    "lavfi.astats.Overall.RMS_level=-inf",
    "frame:1    pts:1440    pts_time:0.03",
    "lavfi.astats.Overall.RMS_level=-20.5",
  ].join("\n");
  expect(parseLevels(text, 10)).toEqual([
    { t: 10, db: -Infinity },
    { t: 10.03, db: -20.5 },
  ]);
});

test("a summary counts what the timeline holds", () => {
  const s = summarize(timeline);
  expect(s).toContain("1 narration lines, 2 actions, 1 boxes, 0 clicks, 0 keys, last at 9.0 s");
  expect(s).toContain("box: add@2.0-4.0 [1,2 30x40]");
});

test("measures a video: when the picture changes, how loud it is, a click's reaction", () => {
  const video = blackThenWhite();
  const changes = screenChanges(video, 0.5, 1);
  expect(changes).toHaveLength(1);
  expect(changes[0].t).toBeCloseTo(1, 2);
  expect(changes[0].diff).toBeGreaterThan(100);

  const levels = audioLevels(video, 0.3, 0.45);
  expect(levels.filter((l) => l.t < 0.48).every((l) => l.db < -60)).toBe(true);
  expect(levels.filter((l) => l.t > 0.55).every((l) => l.db > -30)).toBe(true);

  const [r] = clickReactions(video, [0.6]);
  expect(r.reaction).toBeCloseTo(0.4, 2);
});

test("a contact sheet puts the frames in rows, labelled", () => {
  const video = blackThenWhite();
  const out = join(mkdtempSync(join(tmpdir(), "howreel-sheet-test-")), "sheet.png");
  contactSheet({ video, out, times: [0.2, 0.8, 1.2, 1.6], labels: ["a: 50%", "b"], width: 160 });
  expect(existsSync(out)).toBe(true);
  // Three to a row: two rows of 160x90 frames.
  expect(imageSize(out)).toEqual({ width: 480, height: 180 });
});
