// Checks of a finished video (a draft from `coanda subtitles`, or a voiced video from `coanda
// voice`) against its own timeline, `<name>.timeline.json` beside it, and its voice report,
// `<name>.voice.json`. Each check returns what it found rather than printing it; runChecks runs
// them all. Timing that the viewer sees is measured in the video itself.
//
// checkWords re-transcribes a voiced video with ElevenLabs, which costs money, so runChecks
// never calls it.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import type { Marking, PointerSample, Timeline } from "../shared/types.ts";
import { duration, ffmpeg, imageSize } from "./ffmpeg.ts";
import { DEFAULT_MARKING_STYLE } from "./markings.ts";
import { contactSheet, FPS, frameDifferences } from "./measure.ts";
import type { VoiceReport } from "./voice.ts";
import { estimateSeconds } from "./voicePlan.ts";

/** Something a check found, at a time in the video. */
export interface Finding {
  check: string;
  t: number;
  message: string;
}

/** A narration line as the video plays it: from `at`, for `seconds`. */
export interface SpokenLine {
  key: string;
  text: string;
  at: number;
  seconds: number;
}

/** Something happening on screen: a click, typing, or the pointer moving. A click is an instant,
 * with `from` equal to `to`. */
export interface Action {
  what: string;
  from: number;
  to: number;
}

/** The timeline beside a video: `<name>.timeline.json`. */
export function readTimeline(video: string): Timeline {
  const v = parse(resolve(video));
  const file = join(v.dir, `${v.name}.timeline.json`);
  if (!existsSync(file)) throw new Error(`No timeline for ${video} at ${file}`);
  return JSON.parse(readFileSync(file, "utf8")) as Timeline;
}

/** The voice report beside a video, `<name>.voice.json`, if there is one. */
export function readVoiceReport(video: string): VoiceReport | undefined {
  const v = parse(resolve(video));
  const file = join(v.dir, `${v.name}.voice.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as VoiceReport) : undefined;
}

/**
 * Where each narration line plays: from the voice report when there is one (a recording's own
 * length, or for a line with none, how long it should take to say), else from the timeline's
 * narration lines at `secondsPerWord`.
 */
export function spokenLines(
  timeline: Timeline,
  report?: VoiceReport,
  secondsPerWord = 0.43,
): SpokenLine[] {
  if (report) {
    return report.lines
      .map((l) => ({ key: l.key, text: l.text, at: l.at, seconds: l.seconds }))
      .sort((a, b) => a.at - b.at);
  }
  return timeline.anchors
    .filter((a) => typeof a.say === "string" && a.say.trim())
    .map((a) => ({
      key: a.key,
      text: a.say!.trim(),
      at: a.t,
      seconds: estimateSeconds(a.say!, secondsPerWord),
    }))
    .sort((a, b) => a.at - b.at);
}

/** Keystrokes closer together than this are one stretch of typing. */
const TYPING_GAP = 1;
/** Pointer samples further apart in time than this are not one movement. */
const SAMPLE_GAP = 0.25;

/**
 * What happens on screen, from the timeline: each click, each stretch of typing, and each
 * stretch of pointer movement. A timeline with no clicks and no pointer (one made before the
 * recorder logged them) gives its logged actions instead, each as an instant.
 */
export function actions(timeline: Timeline): Action[] {
  const out: Action[] = [];
  const presses = timeline.presses ?? [];
  const pointer = timeline.pointer ?? [];
  for (const p of presses) out.push({ what: "click", from: p.t, to: p.t });
  const keys = [...(timeline.keys ?? [])].sort((a, b) => a - b);
  let typing: Action | undefined;
  for (const t of keys) {
    if (typing && t - typing.to <= TYPING_GAP) typing.to = t;
    else {
      typing = { what: "typing", from: t, to: t };
      out.push(typing);
    }
  }
  let moving: Action | undefined;
  for (let i = 1; i < pointer.length; i++) {
    const a = pointer[i - 1];
    const b = pointer[i];
    if (Math.hypot(b.x - a.x, b.y - a.y) <= 0.5) continue;
    const from = b.t - a.t <= SAMPLE_GAP ? a.t : b.t;
    if (moving && from - moving.to <= SAMPLE_GAP) moving.to = b.t;
    else {
      moving = { what: "pointer moving", from, to: b.t };
      out.push(moving);
    }
  }
  if (!presses.length && !pointer.length) {
    for (const a of timeline.anchors) {
      if (a.say === undefined) out.push({ what: a.key, from: a.t, to: a.t });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

/**
 * Say it, then show it: no narration line plays while something happens on screen, and each
 * action starts at least `beat` seconds after the line before it ends. Lines whose key or
 * words are in `sayDuring` (a wrap-up over the last action) may play over an action.
 */
export function sayThenShow(
  lines: SpokenLine[],
  onScreen: Action[],
  opts: { beat?: number; sayDuring?: string[] } = {},
): Finding[] {
  const beat = opts.beat ?? 0.25;
  const allowed = (l: SpokenLine) =>
    (opts.sayDuring ?? []).some((s) => s === l.key || s.trim() === l.text);
  const findings: Finding[] = [];
  const quote = (text: string) => `"${text.length > 50 ? text.slice(0, 47) + "..." : text}"`;
  for (const line of lines) {
    if (allowed(line)) continue;
    const end = line.at + line.seconds;
    for (const a of onScreen) {
      const overlap =
        a.from === a.to
          ? Math.min(a.from - line.at, end - a.from)
          : Math.min(end, a.to) - Math.max(line.at, a.from);
      if (overlap > 0.02) {
        findings.push({
          check: "say-then-show",
          t: round(Math.max(line.at, a.from)),
          message:
            a.from === a.to
              ? `${quote(line.text)} is still being said at ${a.what} (${a.from.toFixed(2)} s), ` +
                `${(end - a.from).toFixed(2)} s before it ends`
              : `${quote(line.text)} plays over ${a.what} (${a.from.toFixed(2)}-${a.to.toFixed(2)} s) ` +
                `for ${overlap.toFixed(2)} s`,
        });
      }
    }
  }
  for (const a of onScreen) {
    const before = lines
      .filter((l) => l.at + l.seconds <= a.from + 0.02)
      .sort((x, y) => y.at + y.seconds - (x.at + x.seconds))[0];
    if (!before || allowed(before)) continue;
    const gap = a.from - (before.at + before.seconds);
    if (gap < beat) {
      findings.push({
        check: "say-then-show",
        t: round(a.from),
        message:
          gap < 0
            ? `${a.what} at ${a.from.toFixed(2)} s starts ${(-gap).toFixed(2)} s before ${quote(before.text)} ends; leave at least ${beat} s after it`
            : `${a.what} at ${a.from.toFixed(2)} s starts ${gap.toFixed(2)} s after ${quote(before.text)} ends; leave at least ${beat} s`,
      });
    }
  }
  return findings.sort((a, b) => a.t - b.t);
}

/** Highlight boxes on screen less than `min` seconds (from starting to fade in until starting
 * to fade out), allowing one frame of rounding. */
export function boxDurations(markings: Marking[], min = 2): Finding[] {
  return markings
    .filter((m) => m.to - m.from < min - 1 / FPS - 0.001)
    .map((m) => ({
      check: "box-duration",
      t: m.from,
      message: `${m.key} is shown ${(m.to - m.from).toFixed(2)} s; it needs at least ${min} s to find and read`,
    }));
}

/** Boxes on screen together for more than `together` seconds that don't leave within
 * `tolerance` seconds of each other. */
export function boxesLeaveTogether(
  markings: Marking[],
  opts: { tolerance?: number; together?: number } = {},
): Finding[] {
  const tolerance = opts.tolerance ?? 0.15;
  const together = opts.together ?? 0.5;
  const findings: Finding[] = [];
  const sorted = [...markings].sort((a, b) => a.from - b.from);
  sorted.forEach((a, i) => {
    for (const b of sorted.slice(i + 1)) {
      const shared = Math.min(a.to, b.to) - Math.max(a.from, b.from);
      if (shared > together && Math.abs(a.to - b.to) > tolerance) {
        const [first, last] = a.to < b.to ? [a, b] : [b, a];
        findings.push({
          check: "boxes-leave-together",
          t: first.to,
          message: `${first.key} and ${last.key} are shown together, but ${first.key} goes at ${first.to.toFixed(2)} s and ${last.key} at ${last.to.toFixed(2)} s`,
        });
      }
    }
  });
  return findings;
}

/** How far, in picture pixels, two boxes' edges can run into each other and still count as
 * side by side. */
const TOUCHING = 8;

/** Boxes on screen at the same time whose rectangles cross, one not inside the other: two
 * boxes fighting over the same item. Boxes side by side, or one around a part of the other,
 * are fine. */
export function boxesCross(markings: Marking[]): Finding[] {
  const findings: Finding[] = [];
  const sorted = [...markings].sort((a, b) => a.from - b.from);
  const inside = (a: Marking, b: Marking) =>
    a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
  sorted.forEach((a, i) => {
    for (const b of sorted.slice(i + 1)) {
      if (Math.min(a.to, b.to) <= Math.max(a.from, b.from)) continue;
      // Neighbours padded into each other share a border; that isn't a crossing.
      const across = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const down = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      const cross = across > TOUCHING && down > TOUCHING;
      if (cross && !inside(a, b) && !inside(b, a)) {
        findings.push({
          check: "boxes-cross",
          t: Math.max(a.from, b.from),
          message: `${a.key} and ${b.key} are shown at the same time and overlap, neither inside the other`,
        });
      }
    }
  });
  return findings;
}

/** Boxes that run past the edge of the frame, usually because what was measured is wider
 * than the thing the box is for. */
export function boxesOffFrame(
  markings: Marking[],
  frame: { width: number; height: number },
): Finding[] {
  return markings
    .filter(
      (m) => m.x < 0 || m.y < 0 || m.x + m.width > frame.width || m.y + m.height > frame.height,
    )
    .map((m) => ({
      check: "box-off-frame",
      t: m.from,
      message: `${m.key} runs off the frame (${m.x},${m.y} ${m.width}x${m.height} in ${frame.width}x${frame.height}); fit it to the item`,
    }));
}

/** A frame difference above this is the app reacting; a ripple or a pointer moving is well
 * below it. */
const REACTION = 2.5;

/**
 * For each click, how long until the screen reacts: the first big change in the video itself
 * (see frameDifferences) from the click until the next click or 2.5 s after. A change in the
 * frames just before the click isn't its reaction. Null when nothing big changes, as after a
 * click into a text box.
 */
export function clickReactions(
  video: string,
  clicks: number[],
): { t: number; reaction: number | null }[] {
  const sorted = [...clicks].sort((a, b) => a - b);
  return sorted.map((t, i) => {
    const from = Math.max(0, t - 2 / FPS);
    const until = Math.min(sorted[i + 1] ?? Infinity, t + 2.5);
    const change = frameDifferences(video, from, until - from).find(
      (f) => f.t > t - 0.5 / FPS && f.diff > REACTION,
    );
    return { t, reaction: change ? round(change.t - t) : null };
  });
}

/** Clicks the screen reacts to less than `min` seconds later. */
export function checkClickReactions(
  reactions: { t: number; reaction: number | null }[],
  min = 0.3,
): Finding[] {
  return reactions
    .filter((r) => r.reaction !== null && r.reaction < min)
    .map((r) => ({
      check: "click-reaction",
      t: r.t,
      message: `the screen reacts ${r.reaction!.toFixed(2)} s after the click at ${r.t.toFixed(2)} s; leave at least ${min} s`,
    }));
}

/**
 * Pointer jumps: a step between two samples longer than `minJump` picture pixels and more than
 * four times the steps either side of it, so a glide's own fast middle doesn't count.
 */
export function pointerJumps(pointer: PointerSample[], minJump = 40): Finding[] {
  const steps = pointer.map((p, i) =>
    i === 0 ? 0 : Math.hypot(p.x - pointer[i - 1].x, p.y - pointer[i - 1].y),
  );
  const near = (i: number, j: number) =>
    j > 0 && j < pointer.length && Math.abs(pointer[j].t - pointer[i].t) <= SAMPLE_GAP + 0.05
      ? steps[j]
      : 0;
  const findings: Finding[] = [];
  for (let i = 1; i < pointer.length; i++) {
    const d = steps[i];
    if (d > minJump && d > 4 * Math.max(near(i, i - 1), near(i, i + 1))) {
      const [a, b] = [pointer[i - 1], pointer[i]];
      findings.push({
        check: "pointer-jump",
        t: b.t,
        message: `the pointer jumps ${Math.round(d)} px at ${b.t.toFixed(2)} s, from ${Math.round(a.x)},${Math.round(a.y)} to ${Math.round(b.x)},${Math.round(b.y)}`,
      });
    }
  }
  return findings;
}

/** Where the drawn pointer is at each frame from 0 to `seconds`: the last sample's place, or
 * between two samples when they are close in time. Null before the first sample. */
export function pointerFrames(
  pointer: PointerSample[],
  seconds: number,
): ({ x: number; y: number } | null)[] {
  const out: ({ x: number; y: number } | null)[] = [];
  let k = 0;
  for (let n = 0; n <= Math.round(seconds * FPS); n++) {
    const t = n / FPS;
    while (k + 1 < pointer.length && pointer[k + 1].t <= t) k++;
    const a = pointer[k];
    if (!a || a.t > t) {
      out.push(null);
      continue;
    }
    const b = pointer[k + 1];
    if (b && b.t - a.t <= 0.1) {
      const f = (t - a.t) / (b.t - a.t);
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    } else out.push({ x: a.x, y: a.y });
  }
  return out;
}

/**
 * Stops in the middle of a glide: the pointer moves, rests 0.2 to 2 s, then carries on in about
 * the same direction, with no click during the rest. A stall in the recording (the driver was
 * busy) looks like this, and so does a freeze laid over a move.
 */
export function glideStops(pointer: PointerSample[], clicks: number[] = []): Finding[] {
  if (pointer.length < 2) return [];
  const pos = pointerFrames(pointer, pointer.at(-1)!.t);
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(b.x - a.x, b.y - a.y);
  const findings: Finding[] = [];
  for (let n = 2; n < pos.length - 2; n++) {
    const [p2, p1, p0] = [pos[n - 2], pos[n - 1], pos[n]];
    if (!p2 || !p1 || !p0) continue;
    const v1 = [p1.x - p2.x, p1.y - p2.y];
    if (Math.hypot(v1[0], v1[1]) < 2 || dist(p1, p0) > 0.5) continue;
    let m = n;
    while (m + 1 < pos.length && pos[m + 1] && dist(pos[m]!, pos[m + 1]!) <= 0.5) m++;
    const rest = (m - n + 1) / FPS;
    const [q1, q2] = [pos[m + 1], pos[m + 2]];
    if (rest < 0.2 || rest > 2 || !q1 || !q2) {
      n = m;
      continue;
    }
    if (clicks.some((c) => c >= n / FPS - 0.1 && c <= (m + 1) / FPS + 0.1)) {
      n = m;
      continue;
    }
    const v2 = [q2.x - q1.x, q2.y - q1.y];
    const cos =
      (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]));
    if (Math.hypot(v2[0], v2[1]) >= 2 && cos > Math.cos(Math.PI / 5)) {
      findings.push({
        check: "glide-stop",
        t: round(n / FPS),
        message: `the pointer stops ${rest.toFixed(2)} s in the middle of a move at ${(n / FPS).toFixed(2)} s`,
      });
    }
    n = m;
  }
  return findings;
}

/**
 * Writes a sheet per highlight box into `dir`, `box-<nn>.png`, with frames as it's drawing,
 * drawn, at its last moment and just after it has gone, each labelled. Look at every one: the
 * box surrounds the whole item and nothing else, appears on the word that names the item, the
 * pointer is still while the line is said, and boxes shown together leave together.
 */
export function reviewSheets(
  video: string,
  timeline: Timeline,
  dir: string,
  log: (line: string) => void = () => {},
): string[] {
  const fade = timeline.markingStyle?.fade ?? DEFAULT_MARKING_STYLE.fade;
  const end = duration(video) - 0.05;
  return (timeline.markings ?? []).map((m, k) => {
    const shots: [string, number][] = [
      [`${m.key} drawing`, m.from + fade * 0.5],
      [`${m.key} drawn`, m.from + fade + 0.35],
      [`${m.key} last`, m.to - 0.05],
      [`${m.key} after`, m.to + fade + 0.1],
    ];
    // A box shown less than its fade is "last" before it's fully drawn.
    shots.sort((a, b) => a[1] - b[1]);
    const out = contactSheet({
      video,
      out: join(dir, `box-${String(k + 1).padStart(2, "0")}.png`),
      times: shots.map(([, t]) => Math.min(end, Math.max(0, t))),
      labels: shots.map(([label]) => label),
      columns: 2,
    });
    log(out);
    return out;
  });
}

/** Runs every check that costs nothing on a finished video. The timeline and voice report
 * default to the ones beside it. `skipped` says which checks had nothing to check and why. */
export function runChecks(opts: {
  video: string;
  timeline?: Timeline;
  report?: VoiceReport;
  minBox?: number;
  minReaction?: number;
  sayDuring?: string[];
}): { findings: Finding[]; skipped: string[] } {
  const video = resolve(opts.video);
  const timeline = opts.timeline ?? readTimeline(video);
  const report = opts.report ?? readVoiceReport(video);
  const markings = (timeline.markings ?? []).filter((m) => m.kind === "box");
  const clicks = (timeline.presses ?? []).map((p) => p.t);
  const pointer = timeline.pointer ?? [];
  const skipped: string[] = [];
  if (!report) skipped.push("no voice report: narration lines timed at 0.43 s a word");
  if (!clicks.length && !pointer.length) {
    skipped.push("no clicks or pointer in the timeline: say-then-show uses the logged actions");
  }
  const findings = [
    ...sayThenShow(spokenLines(timeline, report), actions(timeline), {
      sayDuring: opts.sayDuring,
    }),
    ...boxDurations(markings, opts.minBox),
    ...boxesLeaveTogether(markings),
    ...boxesCross(markings),
    ...boxesOffFrame(markings, imageSize(video)),
  ];
  if (clicks.length) {
    findings.push(...checkClickReactions(clickReactions(video, clicks), opts.minReaction));
  } else skipped.push("click-reaction: no clicks in the timeline");
  if (pointer.length) {
    findings.push(...pointerJumps(pointer), ...glideStops(pointer, clicks));
  } else skipped.push("pointer-jump, glide-stop: no pointer in the timeline");
  return { findings: findings.sort((a, b) => a.t - b.t), skipped };
}

/** A word heard in a recording, in seconds. */
export interface HeardWord {
  text: string;
  start: number;
  end: number;
}

const NUMBERS: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
};

/** A word as it's compared: lower case, letters, digits and apostrophes only, numbers as
 * digits. */
export function normalizeWord(word: string): string {
  const w = word
    .toLowerCase()
    .normalize("NFC")
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}']/gu, "")
    .replace(/^'+|'+$/g, "");
  return NUMBERS[w] ?? w;
}

const words = (text: string) =>
  text
    .split(/[\s\-–—/]+/)
    .map(normalizeWord)
    .filter(Boolean);

/**
 * Every word of the script must be heard once, in order, while its own line plays: compares the
 * lines' words with the heard words by their longest common sequence. `sameWords` lists pairs
 * [script word, heard word] to accept as the same, for words speech recognition hears another
 * way.
 */
export function matchWords(
  lines: SpokenLine[],
  heard: HeardWord[],
  sameWords: [string, string][] = [],
): Finding[] {
  const as = new Map<string, string>();
  for (const [script, other] of sameWords) {
    as.set(normalizeWord(other), normalizeWord(script));
  }
  const canon = (w: string) => as.get(w) ?? w;
  const want = lines.flatMap((line) => words(line.text).map((w) => ({ w: canon(w), line })));
  const got = heard.map((h) => ({ ...h, w: canon(normalizeWord(h.text)) })).filter((h) => h.w);
  // dp[i][j]: the longest common sequence of want[i..] and got[j..].
  const dp = Array.from({ length: want.length + 1 }, () => new Int32Array(got.length + 1));
  for (let i = want.length - 1; i >= 0; i--) {
    for (let j = got.length - 1; j >= 0; j--) {
      dp[i][j] =
        want[i].w === got[j].w ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const findings: Finding[] = [];
  let i = 0;
  let j = 0;
  while (i < want.length || j < got.length) {
    if (i < want.length && j < got.length && want[i].w === got[j].w) {
      const { line } = want[i];
      const h = got[j];
      if (h.end < line.at + 0.05 || h.start > line.at + line.seconds - 0.15) {
        findings.push({
          check: "words",
          t: round(h.start),
          message: `"${h.text}" of "${line.text}" is heard at ${h.start.toFixed(2)}-${h.end.toFixed(2)} s, outside its line (${line.at.toFixed(2)}-${(line.at + line.seconds).toFixed(2)} s)`,
        });
      }
      i++;
      j++;
    } else if (j < got.length && (i >= want.length || dp[i][j + 1] >= dp[i + 1][j])) {
      findings.push({
        check: "words",
        t: round(got[j].start),
        message: `"${got[j].text}" is heard at ${got[j].start.toFixed(2)} s but isn't in the script there`,
      });
      j++;
    } else {
      const { w, line } = want[i];
      findings.push({
        check: "words",
        t: line.at,
        message: `"${w}" of "${line.text}" is not heard`,
      });
      i++;
    }
  }
  return findings.sort((a, b) => a.t - b.t);
}

/**
 * Transcribes the video's sound with ElevenLabs speech to text, which costs money, and checks
 * every word of its narration with matchWords. Only for a voiced video.
 */
export async function checkWords(opts: {
  video: string;
  apiKey: string;
  timeline?: Timeline;
  report?: VoiceReport;
  sameWords?: [string, string][];
  model?: string;
  /** An ISO 639 code, such as "eng"; ElevenLabs detects the language without it. */
  language?: string;
}): Promise<Finding[]> {
  const video = resolve(opts.video);
  const timeline = opts.timeline ?? readTimeline(video);
  const report = opts.report ?? readVoiceReport(video);
  if (report?.silent) throw new Error(`${video} is a silent draft: there is nothing to hear`);
  const heard = await transcribe(video, opts.apiKey, opts.model, opts.language);
  return matchWords(spokenLines(timeline, report), heard, opts.sameWords);
}

/** The words ElevenLabs hears in a video's sound, with their times. */
export async function transcribe(
  video: string,
  apiKey: string,
  model = "scribe_v1",
  language?: string,
): Promise<HeardWord[]> {
  const audio = join(tmpdir(), `coanda-words-${process.pid}-${Date.now()}.mp3`);
  try {
    ffmpeg(["-i", video, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", audio]);
    const form = new FormData();
    form.append("model_id", model);
    form.append("timestamps_granularity", "word");
    form.append("tag_audio_events", "false");
    if (language) form.append("language_code", language);
    form.append("file", new Blob([readFileSync(audio)], { type: "audio/mpeg" }), "narration.mp3");
    const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
    });
    if (!response.ok) {
      throw new Error(`ElevenLabs speech to text: ${response.status} ${await response.text()}`);
    }
    const reply = (await response.json()) as {
      words: { text: string; start: number; end: number; type: string }[];
    };
    return reply.words
      .filter((w) => w.type === "word")
      .map((w) => ({ text: w.text, start: w.start, end: w.end }));
  } finally {
    rmSync(audio, { force: true });
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;
