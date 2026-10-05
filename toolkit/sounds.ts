// Click and typing sounds for the voice pass: a click at each press and a typing bed while keys
// are being typed, from the timeline's `presses` and `keys`. Drafts stay silent.
//
// The sounds are toolkit/assets/click.mp3 (one click) and typing.mp3 (1.6 s of typing that
// starts on a keystroke, so the bed starts with the first letter). Both were made with ffmpeg
// from filtered noise.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Timeline } from "../shared/types.ts";
import { ffmpeg } from "./ffmpeg.ts";

const ASSETS = fileURLToPath(new URL("./assets/", import.meta.url));
export const CLICK_SOUND = join(ASSETS, "click.mp3");
export const TYPING_SOUND = join(ASSETS, "typing.mp3");

/** The click's volume, and the typing bed's, against the sound files as they are. */
export const CLICK_GAIN = 0.55;
export const TYPING_GAIN = 0.32;
/** The click starts this long before the press, so its attack lands on it. */
export const CLICK_LEAD = 0.01;
/** Keys further apart than this, in seconds, are separate runs of typing. */
export const TYPING_BREAK = 0.6;
/** How long a run's typing sound goes on after its last key. */
export const TYPING_TAIL = 0.12;

export interface SoundPlacement {
  /** When each click sound starts. */
  clicks: number[];
  /** Each run of typing, as [start, end]. */
  typing: [number, number][];
}

/**
 * Where the sounds go: a click for each press and a typing bed over each run of keys, with
 * `shift` taking a moment of the silent picture to the voiced one. A timeline with no `presses`
 * or `keys` has no sounds.
 */
export function placeSounds(
  timeline: Pick<Timeline, "presses" | "keys">,
  shift: (t: number) => number = (t) => t,
): SoundPlacement {
  const clicks = (timeline.presses ?? [])
    .map((p) => p.t)
    .filter(Number.isFinite)
    .map((t) => round(Math.max(0, shift(t) - CLICK_LEAD)))
    .sort((a, b) => a - b);
  const keys = (timeline.keys ?? [])
    .filter(Number.isFinite)
    .map(shift)
    .sort((a, b) => a - b);
  const typing: [number, number][] = [];
  if (keys.length) {
    let start = keys[0];
    let previous = keys[0];
    for (const k of [...keys.slice(1), Infinity]) {
      if (k - previous > TYPING_BREAK) {
        typing.push([round(start), round(previous + TYPING_TAIL)]);
        start = k;
      }
      previous = k;
    }
  }
  return { clicks, typing };
}

/** True when there is a sound to place. */
export function hasSounds(placement: SoundPlacement): boolean {
  return placement.clicks.length > 0 || placement.typing.length > 0;
}

/**
 * The ffmpeg filters that lay the sounds out on one track, `[output]`, `seconds` long. The click
 * sound is input `clickInput`; the typing sound is input `typingInput`, which must be looped
 * (`-stream_loop -1`) so a run can be longer than the file.
 */
export function soundFilters(opts: {
  placement: SoundPlacement;
  clickInput: number;
  typingInput: number;
  output: string;
  seconds: number;
}): string[] {
  const { clicks, typing } = opts.placement;
  const filters: string[] = [];
  const parts: string[] = [];
  const split = (input: number, n: number, name: string) => {
    const outs = Array.from({ length: n }, (_, k) => `[${name}${k}]`);
    filters.push(`[${input}:a]aresample=48000,${n > 1 ? `asplit=${n}` : "anull"}${outs.join("")}`);
    return outs;
  };
  if (clicks.length) {
    split(opts.clickInput, clicks.length, "c").forEach((from, k) => {
      filters.push(`${from}volume=${CLICK_GAIN},adelay=${ms(clicks[k])}:all=1[ck${k}]`);
      parts.push(`[ck${k}]`);
    });
  }
  if (typing.length) {
    split(opts.typingInput, typing.length, "t").forEach((from, k) => {
      const [start, end] = typing[k];
      const length = Math.max(end - start, 0.05);
      const fadeOut = Math.min(0.03, length / 2);
      filters.push(
        `${from}atrim=duration=${length.toFixed(3)},asetpts=PTS-STARTPTS,` +
          `afade=t=out:st=${(length - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)},` +
          `volume=${TYPING_GAIN},adelay=${ms(start)}:all=1[ty${k}]`,
      );
      parts.push(`[ty${k}]`);
    });
  }
  const total = opts.seconds.toFixed(3);
  filters.push(
    parts.length
      ? `${parts.join("")}amix=inputs=${parts.length}:normalize=0:duration=longest,` +
          `apad=whole_dur=${total},atrim=duration=${total}${opts.output}`
      : `anullsrc=r=48000:cl=mono,atrim=duration=${total}${opts.output}`,
  );
  return filters;
}

/** Writes the sounds as one mono WAV track, `seconds` long, to mix under the narration. */
export function renderSounds(placement: SoundPlacement, seconds: number, out: string): void {
  ffmpeg([
    "-i",
    CLICK_SOUND,
    "-stream_loop",
    "-1",
    "-i",
    TYPING_SOUND,
    "-filter_complex",
    soundFilters({ placement, clickInput: 0, typingInput: 1, output: "[s]", seconds }).join(";"),
    "-map",
    "[s]",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-t",
    seconds.toFixed(3),
    out,
  ]);
}

const ms = (seconds: number) => Math.round(seconds * 1000);
const round = (n: number) => Math.round(n * 1000) / 1000;
