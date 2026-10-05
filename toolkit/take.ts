// What happens to a take after the recorder: its frames become a steady 30 fps video, and the
// video goes between a title card and an end card to make the silent picture, with the
// picture's timeline (narration lines, actions, markings, the pointer, presses and keys at
// their times in it). Optionally, stretches where nothing happens are shortened on the way.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Marking, Timeline } from "../shared/types.ts";
import { duration, ffmpeg, findTool, imageSize } from "./ffmpeg.ts";
import { DEFAULT_MARKING_STYLE, settleBoxes } from "./markings.ts";
import { findRecipe } from "./recipe.ts";
import { estimateSpeech, type TakeEvents } from "./recorder.ts";

/** Makes `<take>/screen.mp4` from the take's frames, each held until the next one's time. The
 * first frame is held from the start of capture, so the video's 0 is events.json's 0. */
export function framesToVideo(takeDir: string): string {
  const frames = JSON.parse(readFileSync(join(takeDir, "frames.json"), "utf8")) as {
    file: string;
    t: number;
  }[];
  const { start, events } = readEvents(takeDir);
  if (!frames.length) throw new Error(`No frames in ${takeDir}`);
  const end = Math.max(start + (events.at(-1)?.t ?? 0), frames.at(-1)!.t);
  const lines: string[] = [];
  frames.forEach((frame, i) => {
    const from = i === 0 ? start : frame.t;
    const to = i + 1 < frames.length ? frames[i + 1].t : end;
    if (to <= from) return;
    lines.push(`file 'frames/${frame.file}'`, `duration ${(to - from).toFixed(4)}`);
  });
  lines.push(`file 'frames/${frames.at(-1)!.file}'`);
  writeFileSync(join(takeDir, "concat.txt"), lines.join("\n"));
  const out = join(takeDir, "screen.mp4");
  ffmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    join(takeDir, "concat.txt"),
    "-vf",
    "fps=30,format=yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "16",
    "-preset",
    "slow",
    out,
  ]);
  return out;
}

export function readEvents(takeDir: string): TakeEvents {
  return JSON.parse(readFileSync(join(takeDir, "events.json"), "utf8")) as TakeEvents;
}

/** Title and end cards: images the size of the take's frames. */
export interface Cards {
  /** The title card's picture, which pushes in slowly. */
  title: string;
  /** Optional: the title card's text, with transparency, which fades in over the picture. */
  titleText?: string;
  end: string;
}

/** How long the title card holds before the screen fades in over it. */
const TITLE = 4.4;
/** How long the screen and the end card take to fade in. */
const FADE = 0.7;
/** How long the end card stays after it has faded in. */
const END = 5;

/** Shortening still stretches: where the picture doesn't change and nothing is said, logged,
 * marked, moved, pressed or typed for longer than `longerThan` seconds (default 2), the middle
 * is cut, leaving `keep` seconds (default 1), half from each end. */
export interface IdleTrim {
  longerThan?: number;
  keep?: number;
}

/**
 * Puts the take's screen.mp4 between the cards, making the silent picture at `out`, and writes
 * its timeline beside it (`<out name>.timeline.json`): each narration line as an anchor keyed
 * `line: <words>` with `say`, each logged action, the markings, the pointer, presses and keys,
 * all moved past the title card. Boxes and arrows are kept up at least 2 s, and those that end
 * close together end together. With `trimIdle`, still stretches are shortened and every time
 * moves with them.
 */
export function assemble(opts: {
  takeDir: string;
  cards: Cards;
  out: string;
  trimIdle?: IdleTrim | boolean;
}): {
  seconds: number;
  timeline: string;
  /** Seconds taken out of the take by `trimIdle`. */
  trimmed: number;
} {
  const screen = join(opts.takeDir, "screen.mp4");
  if (!existsSync(screen)) throw new Error(`No ${screen}: make it from the frames first`);
  for (const file of [opts.cards.title, opts.cards.titleText, opts.cards.end]) {
    if (file && !existsSync(file)) throw new Error(`No card at ${file}`);
  }
  const { width, height } = imageSize(screen);
  const logged = readEvents(opts.takeDir);
  const edited = applyMarkingEdits(logged.markings, findMarkingEdits(opts.takeDir, opts.out));
  for (const key of edited.missing) {
    console.warn(`markingEdits has "${key}", but the take logged no marking with that key`);
  }
  const take = { ...logged, markings: edited.markings };
  const trim = opts.trimIdle === true ? {} : opts.trimIdle || undefined;
  const takeSeconds = duration(screen);
  const cuts = trim
    ? idleCuts(stillStretches(screen, trim.keep ?? IDLE_KEEP), busyStretches(take), trim)
    : [];
  const trimmed = cuts.reduce((n, [a, b]) => n + b - a, 0);
  const screenSeconds = takeSeconds - trimmed;
  // Frames inside a cut are dropped and the rest closed up, at 30 fps.
  const cut = cuts.length
    ? `select='not(${cuts.map(([a, b]) => `between(t,${(a - 0.001).toFixed(4)},${(b - 0.001).toFixed(4)})`).join("+")})',setpts=N/(30*TB),`
    : "";
  const endStart = TITLE + screenSeconds - FADE;
  const total = endStart + FADE + END;
  const titleSeconds = (TITLE + FADE + 0.1).toFixed(3);

  const still = (file: string, seconds: string) => [
    "-loop",
    "1",
    "-framerate",
    "30",
    "-t",
    seconds,
    "-i",
    file,
  ];
  const inputs = [
    ...still(opts.cards.title, titleSeconds),
    ...(opts.cards.titleText ? still(opts.cards.titleText, titleSeconds) : []),
    "-i",
    screen,
    ...still(opts.cards.end, (FADE + END).toFixed(3)),
  ];
  const at = opts.cards.titleText ? 1 : 0;
  const filters = [
    `color=c=black:s=${width}x${height}:r=30:d=${total.toFixed(3)}[base]`,
    // The picture pushes in slowly while the title text fades in.
    `[0]scale=${width * 2}:${height * 2},zoompan=z='min(1+0.045*on/150\\,1.045)':` +
      `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=30,setsar=1[bg]`,
    ...(opts.cards.titleText
      ? [
          `[1]format=rgba,fade=in:st=0.3:d=0.9:alpha=1[tx]`,
          `[bg][tx]overlay,trim=duration=${titleSeconds}[title]`,
        ]
      : [`[bg]trim=duration=${titleSeconds}[title]`]),
    `[${at + 1}]fps=30,${cut}setsar=1,format=yuva420p,fade=in:st=0:d=${FADE}:alpha=1,` +
      `setpts=PTS-STARTPTS+${TITLE}/TB[scr]`,
    `[${at + 2}]scale=${width}:${height},format=yuva420p,fade=in:st=0:d=${FADE}:alpha=1,` +
      `setpts=PTS-STARTPTS+${endStart.toFixed(3)}/TB[end]`,
    `[base][title]overlay=eof_action=pass[a]`,
    `[a][scr]overlay=eof_action=pass[b]`,
    `[b][end]overlay=eof_action=repeat,format=yuv420p[v]`,
  ];
  ffmpeg([
    ...inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[v]",
    "-t",
    total.toFixed(3),
    "-c:v",
    "libx264",
    "-crf",
    "17",
    "-preset",
    "slow",
    "-movflags",
    "+faststart",
    opts.out,
  ]);

  const timeline = takeTimeline(take, cuts);
  const timelinePath = opts.out.replace(/\.[^.\\/]+$/, "") + ".timeline.json";
  writeFileSync(timelinePath, JSON.stringify(timeline, null, 1));
  return { seconds: total, timeline: timelinePath, trimmed: Number(trimmed.toFixed(3)) };
}

/** The picture's timeline from the take's events: every time moved past the cuts and the
 * title card, and the boxes and arrows settled (see `settleBoxes`). */
export function takeTimeline(take: TakeEvents, cuts: [number, number][] = []): Timeline {
  const moved = cutTime(cuts);
  const inPicture = (t: number) => Number((TITLE + moved(t)).toFixed(3));
  const sample = (p: { t: number; x: number; y: number }) => ({ ...p, t: inPicture(p.t) });
  return {
    anchors: take.events.map((e) =>
      "say" in e
        ? { key: `line: ${e.say}`, t: inPicture(e.t), say: e.say }
        : { key: e.what, t: inPicture(e.t) },
    ),
    markingStyle: { scale: take.scale },
    markings: settleBoxes(
      take.markings.map((m) => ({ ...m, from: inPicture(m.from), to: inPicture(m.to) })),
    ),
    pointer: (take.pointer ?? []).map(sample),
    presses: (take.presses ?? []).map(sample),
    keys: (take.keys ?? []).map(inPicture),
  };
}

/** Changes to logged markings, by marking key: each value's fields replace the logged ones.
 * Times are take seconds, as in events.json. */
export type MarkingEdits = Record<string, Partial<Marking>>;

/** The project's `markingEdits` (video-project.json), found from the take's folder, or else
 * from the folder of `out`. */
export function findMarkingEdits(takeDir: string, out: string): MarkingEdits {
  for (const dir of [takeDir, dirname(out)]) {
    const edits = findRecipe(dir).recipe.markingEdits;
    if (edits && typeof edits === "object") return edits as MarkingEdits;
  }
  return {};
}

/** The markings with `edits` applied, and the edited keys no marking has. */
export function applyMarkingEdits(
  markings: Marking[],
  edits: MarkingEdits,
): { markings: Marking[]; missing: string[] } {
  const keys = new Set(markings.map((m) => m.key));
  return {
    markings: markings.map((m) => (edits[m.key] ? { ...m, ...edits[m.key], key: m.key } : m)),
    missing: Object.keys(edits).filter((key) => !keys.has(key)),
  };
}

/** IdleTrim's defaults. */
const IDLE_KEEP = 1;
const IDLE_LONGER_THAN = 2;
/** Seconds kept clear around anything that happens. */
const BUSY_MARGIN = 0.2;

/** Where a time in the take is once `cuts` (sorted, not overlapping) are taken out. A time
 * inside a cut goes to where the cut was. */
export function cutTime(cuts: [number, number][]): (t: number) => number {
  return (t) => {
    let out = t;
    for (const [a, b] of cuts) if (t > a) out -= Math.min(t, b) - a;
    return out;
  };
}

/** The stretches of the take in which something happens: each line while it would be spoken,
 * each logged action, each marking for as long as it's on screen (cutting under a box would
 * shorten it), each pointer sample, press and key. */
export function busyStretches(take: TakeEvents): [number, number][] {
  const fade = DEFAULT_MARKING_STYLE.fade;
  const busy: [number, number][] = [
    ...take.events.map((e): [number, number] =>
      "say" in e ? [e.t, e.t + estimateSpeech(e.say, take.secondsPerWord)] : [e.t, e.t],
    ),
    ...take.markings.map((m: Marking): [number, number] =>
      m.kind === "dissolve" ? [m.from, m.to] : [m.from, m.to + fade],
    ),
    ...[...(take.pointer ?? []), ...(take.presses ?? [])].map((p): [number, number] => [p.t, p.t]),
    ...(take.keys ?? []).map((t): [number, number] => [t, t]),
  ];
  return busy.sort((a, b) => a[0] - b[0]);
}

/**
 * What to cut from the take: of each still stretch, the parts clear of anything busy (by
 * `BUSY_MARGIN`) that are longer than `longerThan`, less `keep` seconds split between their
 * ends, on whole frames at `fps`.
 */
export function idleCuts(
  stills: [number, number][],
  busy: [number, number][],
  opts: IdleTrim = {},
  fps = 30,
): [number, number][] {
  const longerThan = opts.longerThan ?? IDLE_LONGER_THAN;
  const keep = Math.min(opts.keep ?? IDLE_KEEP, longerThan);
  const cuts: [number, number][] = [];
  for (const [s, e] of stills) {
    let from = s;
    const quiet: [number, number][] = [];
    for (const [a, b] of busy) {
      if (b + BUSY_MARGIN <= from || a - BUSY_MARGIN >= e) continue;
      if (a - BUSY_MARGIN > from) quiet.push([from, a - BUSY_MARGIN]);
      from = Math.max(from, b + BUSY_MARGIN);
    }
    if (e > from) quiet.push([from, e]);
    for (const [a, b] of quiet) {
      if (b - a <= longerThan) continue;
      const cutFrom = Math.ceil((a + keep / 2) * fps - 1e-6) / fps;
      const cutTo = Math.floor((b - keep / 2) * fps + 1e-6) / fps;
      if (cutTo > cutFrom) cuts.push([round(cutFrom), round(cutTo)]);
    }
  }
  return cuts.sort((a, b) => a[0] - b[0]);
}

/** How much a pixel of the shrunken picture must change for a frame to count as changed: the
 * drawn pointer moving gives 100 or more, a still screen's encoding noise 10 or less. */
const CHANGED = 24;

/**
 * The stretches of a video at least `seconds` long in which its picture doesn't change. A frame
 * changed if any pixel of it, shrunk to 384 pixels wide, differs from the frame before by more
 * than `CHANGED`: ffmpeg's freezedetect averages over the whole frame, so it misses the pointer
 * moving or a caret.
 */
export function stillStretches(video: string, seconds: number): [number, number][] {
  const run = spawnSync(
    findTool("ffmpeg"),
    [
      "-hide_banner",
      "-v",
      "error",
      "-i",
      video,
      "-vf",
      "scale=384:-2:flags=area,format=gray,tblend=all_mode=difference,signalstats," +
        "metadata=print:key=lavfi.signalstats.YMAX:file=-",
      "-an",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 1 << 28 },
  );
  if (run.status !== 0) throw new Error(`Could not measure changes in ${video}: ${run.stderr}`);
  const changes: number[] = [];
  let t = 0;
  for (const line of run.stdout.split(/\r?\n/)) {
    const time = /pts_time:([0-9.]+)/.exec(line);
    const max = /YMAX=(\d+)/.exec(line);
    if (time) t = Number(time[1]);
    if (max && Number(max[1]) > CHANGED) changes.push(t);
  }
  return stillsBetween(changes, duration(video), seconds);
}

/** The stretches at least `seconds` long between the times the picture changed, from 0 to
 * `end`. */
export function stillsBetween(changes: number[], end: number, seconds: number): [number, number][] {
  const edges = [0, ...changes, end];
  const stills: [number, number][] = [];
  for (let i = 1; i < edges.length; i++) {
    if (edges[i] - edges[i - 1] >= seconds) stills.push([edges[i - 1], edges[i]]);
  }
  return stills;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The longest silences between subtitles in an .srt, longest first. */
export function gaps(srtText: string, count = 10): { gap: number; at: number; text: string }[] {
  const seconds = (stamp: string) => {
    const [h, m, s] = stamp.trim().split(":");
    return Number(h) * 3600 + Number(m) * 60 + Number(s.replace(",", "."));
  };
  const cues = srtText
    .trim()
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const [from, to] = lines[1].split(" --> ").map(seconds);
      return { from, to, text: lines.slice(2).join(" ") };
    });
  return cues
    .slice(1)
    .map((cue, i) => ({ gap: cue.from - cues[i].to, at: cue.from, text: cue.text }))
    .sort((a, b) => b.gap - a.gap)
    .slice(0, count);
}
