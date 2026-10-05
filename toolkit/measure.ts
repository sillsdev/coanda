// Measuring a video instead of guessing at it: frames at given moments as one labelled sheet,
// the moments the picture changes, and how loud the sound is over a stretch. The checks in
// checks.ts are built on these.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Timeline } from "../shared/types.ts";
import { findTool } from "./ffmpeg.ts";

/** A part of the picture, in its pixels. */
export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Reads a crop written as w:h:x:y, as ffmpeg's crop filter takes it. */
export function parseCrop(text: string): Crop {
  const [width, height, x, y] = text.split(":").map(Number);
  if (![width, height, x, y].every(Number.isFinite)) {
    throw new Error(`Not a crop like 600:400:100:50 (w:h:x:y): ${text}`);
  }
  return { x, y, width, height };
}

const cropFilter = (c: Crop | undefined) =>
  c
    ? `crop=${Math.round(c.width)}:${Math.round(c.height)}:${Math.round(c.x)}:${Math.round(c.y)},`
    : "";

/** A font drawtext can read on this machine, or undefined to leave it to fontconfig. */
function findFont(): string | undefined {
  return [
    process.env.WINDIR && join(process.env.WINDIR, "Fonts", "arial.ttf"),
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ].find((f): f is string => Boolean(f && existsSync(f)));
}

/**
 * Writes `out`, one PNG of the video's frames at `times`, `columns` to a row, each scaled to
 * `width` and labelled with its time and its entry in `labels`. With `crop`, each frame is cut
 * to that part of the picture first, so a small area can be judged at full size.
 */
export function contactSheet(opts: {
  video: string;
  out: string;
  times: number[];
  labels?: string[];
  crop?: Crop;
  columns?: number;
  width?: number;
}): string {
  if (!opts.times.length) throw new Error("No times to take frames at");
  const columns = Math.max(1, Math.min(opts.columns ?? 3, opts.times.length));
  const width = opts.width ?? 616;
  const video = resolve(opts.video);
  const out = resolve(opts.out);
  mkdirSync(dirname(out), { recursive: true });
  // drawtext can't take a path with a drive letter's colon, so it runs in a folder holding a
  // copy of the font and the labels.
  const work = mkdtempSync(join(tmpdir(), "howbench-sheet-"));
  try {
    const font = findFont();
    if (font) copyFileSync(font, join(work, "font.ttf"));
    const files = opts.times.map((t, i) => {
      const label = `${t.toFixed(2)} s${opts.labels?.[i] ? `  ${opts.labels[i]}` : ""}`;
      writeFileSync(join(work, `label${i}.txt`), label);
      const file = `f${i}.png`;
      const text =
        `drawtext=${font ? "fontfile=font.ttf:" : ""}textfile=label${i}.txt:expansion=none:` +
        "x=8:y=8:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=4";
      execFileSync(
        findTool("ffmpeg"),
        [
          "-v",
          "error",
          "-y",
          "-ss",
          Math.max(0, t).toFixed(3),
          "-i",
          video,
          "-frames:v",
          "1",
          "-vf",
          `${cropFilter(opts.crop)}scale=${width}:-2,${text}`,
          file,
        ],
        { cwd: work },
      );
      if (!existsSync(join(work, file))) throw new Error(`No frame at ${t} s in ${video}`);
      return file;
    });
    if (files.length === 1) {
      copyFileSync(join(work, files[0]), out);
      return out;
    }
    // Every frame is the same size, so frame k sits at column k % columns, row k / columns.
    const at = (n: number, size: string) =>
      n === 0 ? "0" : Array.from({ length: n }, () => `${size}0`).join("+");
    const layout = files
      .map((_, k) => `${at(k % columns, "w")}_${at(Math.floor(k / columns), "h")}`)
      .join("|");
    execFileSync(
      findTool("ffmpeg"),
      [
        "-v",
        "error",
        "-y",
        ...files.flatMap((f) => ["-i", f]),
        "-filter_complex",
        `xstack=inputs=${files.length}:layout=${layout}:fill=black`,
        out,
      ],
      { cwd: work },
    );
    return out;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Frames per second the picture is measured at. HowBench's pictures are 30 fps. */
export const FPS = 30;
/** The picture is shrunk to this size before frames are compared. */
const SMALL = { width: 96, height: 54 };

/**
 * How much each frame from `start` for `seconds` differs from the one before it: the mean
 * difference in grey level (0 to 255) over the picture shrunk to 96x54, or over `crop` of it.
 * `t` is the time of the later frame. Big changes (a dialog opening, a page changing) are
 * above 2.5; a pointer moving is well under 1.
 */
export function frameDifferences(
  video: string,
  start: number,
  seconds: number,
  crop?: Crop,
): { t: number; diff: number }[] {
  // Start on a frame, so frame k of the output is at first + k / FPS.
  const first = Math.max(0, Math.ceil(start * FPS - 1e-6) / FPS);
  const size = SMALL.width * SMALL.height;
  const buf = execFileSync(
    findTool("ffmpeg"),
    [
      "-v",
      "error",
      "-ss",
      Math.max(0, first - 0.001).toFixed(4),
      "-t",
      (seconds + start - first).toFixed(4),
      "-i",
      resolve(video),
      "-vf",
      `${cropFilter(crop)}scale=${SMALL.width}:${SMALL.height},fps=${FPS}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ],
    { maxBuffer: 1 << 30 },
  );
  const frames = Math.floor(buf.length / size);
  const out: { t: number; diff: number }[] = [];
  for (let i = 1; i < frames; i++) {
    let d = 0;
    for (let k = 0; k < size; k++) d += Math.abs(buf[i * size + k] - buf[(i - 1) * size + k]);
    out.push({ t: round(first + i / FPS), diff: round(d / size) });
  }
  return out;
}

/** The moments from `start` for `seconds` when the picture (or `crop` of it) changes by more
 * than `threshold` (see frameDifferences), with how much. */
export function screenChanges(
  video: string,
  start: number,
  seconds: number,
  opts: { threshold?: number; crop?: Crop } = {},
): { t: number; diff: number }[] {
  const threshold = opts.threshold ?? 0.6;
  return frameDifferences(video, start, seconds, opts.crop).filter((f) => f.diff > threshold);
}

/**
 * How loud the sound is from `start` for `seconds`, every `step` seconds (default 0.03): the
 * RMS level in dB, -Infinity for silence. Use it to find when a sound really starts.
 */
export function audioLevels(
  video: string,
  start: number,
  seconds: number,
  step = 0.03,
): { t: number; db: number }[] {
  const rate = 48000;
  const out = execFileSync(
    findTool("ffmpeg"),
    [
      "-v",
      "error",
      "-ss",
      start.toFixed(3),
      "-t",
      seconds.toFixed(3),
      "-i",
      resolve(video),
      "-vn",
      "-af",
      `aresample=${rate},asetnsamples=n=${Math.round(rate * step)},astats=metadata=1:reset=1,` +
        "ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
      "-f",
      "null",
      "-",
    ],
    { maxBuffer: 1 << 28 },
  ).toString();
  return parseLevels(out, start);
}

/** Reads ametadata's print-out: a `pts_time:` line, then the level, for each block. */
export function parseLevels(text: string, start: number): { t: number; db: number }[] {
  const levels: { t: number; db: number }[] = [];
  let t = NaN;
  for (const line of text.split(/\r?\n/)) {
    const time = /pts_time:\s*(-?[\d.]+)/.exec(line);
    if (time) t = Number(time[1]);
    const level = /RMS_level=(\S+)/.exec(line);
    if (level && Number.isFinite(t)) {
      const db = level[1] === "-inf" ? -Infinity : Number(level[1]);
      levels.push({ t: round(start + t), db: Number.isFinite(db) ? round(db) : db });
    }
  }
  return levels;
}

/**
 * Times for a sheet, from anchors: each spec is an anchor's key, or the start of one, with an
 * optional offset in seconds, such as `click: Basic Book+0.3` or `end-1`. A plain number is a
 * time. The label is the spec.
 */
export function anchorTimes(timeline: Timeline, specs: string[]): { t: number; label: string }[] {
  return specs.map((spec) => {
    if (/^-?\d+(\.\d+)?$/.test(spec.trim())) return { t: Number(spec), label: "" };
    const m = /^(.*?)([+-]\d+(?:\.\d+)?)?$/.exec(spec)!;
    const name = m[1].trim();
    const anchor =
      timeline.anchors.find((a) => a.key === name) ??
      timeline.anchors.find((a) => a.key.startsWith(name)) ??
      timeline.markings
        ?.filter((b) => b.key === name || b.key.startsWith(name))
        .map((b) => ({ key: b.key, t: b.from }))[0];
    if (!anchor) throw new Error(`No anchor or box in the timeline starts with "${name}"`);
    return { t: round(anchor.t + Number(m[2] ?? 0)), label: spec };
  });
}

/** What a timeline holds, in a few lines: for checking that every step of a recording
 * happened. */
export function summarize(timeline: Timeline): string {
  const lines = timeline.anchors.filter((a) => a.say !== undefined);
  const actions = timeline.anchors.filter((a) => a.say === undefined);
  const at = (t: number) => t.toFixed(1);
  const end = Math.max(
    0,
    ...timeline.anchors.map((a) => a.t),
    ...(timeline.markings ?? []).map((m) => m.to),
  );
  return [
    `${lines.length} narration lines, ${actions.length} actions, ` +
      `${timeline.markings?.length ?? 0} boxes, ${timeline.presses?.length ?? 0} clicks, ` +
      `${timeline.keys?.length ?? 0} keys, last at ${at(end)} s`,
    `actions: ${actions.map((a) => `${a.key}@${at(a.t)}`).join("  ")}`,
    `boxes: ${(timeline.markings ?? [])
      .map(
        (m) =>
          `${m.key}@${at(m.from)}-${at(m.to)} [${Math.round(m.x)},${Math.round(m.y)} ${Math.round(m.width)}x${Math.round(m.height)}]`,
      )
      .join("  ")}`,
  ].join("\n");
}

const round = (n: number) => Math.round(n * 1000) / 1000;
