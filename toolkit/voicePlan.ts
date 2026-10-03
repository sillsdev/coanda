// Laying narration over a silent picture: where each line goes, and where the picture must
// freeze because a line needs longer than its shot gives it.
import type { Timeline, UnvoicedLine } from "../shared/types.ts";

/** A narration line, from the silent picture's timeline. */
export interface NarrationLine {
  key: string;
  text: string;
  /** Where the line starts in the silent picture, in seconds. */
  start: number;
}

/** A line with its sound: a recording, or a gap as long as the line should take to say. */
export interface VoicedLine extends NarrationLine {
  /** The recording's file. Absent for a gap. */
  audio?: string;
  /** How long the recording speaks, or the gap's length. */
  seconds: number;
}

export interface ScheduledLine extends VoicedLine {
  /** Where the line starts in the voiced picture. */
  at: number;
}

export interface Hold {
  /** Where the picture freezes, in the silent picture's time. */
  at: number;
  length: number;
}

/** A line may not run closer than this to the next line's start. */
export const LINE_GAP = 0.25;

/** The narration lines in a timeline: its anchors with words to say, in order. */
export function narrationLines(timeline: Timeline): NarrationLine[] {
  return timeline.anchors
    .filter((a) => typeof a.say === "string" && a.say.trim() && Number.isFinite(a.t))
    .map((a) => ({ key: a.key, text: a.say!.trim(), start: a.t }))
    .sort((a, b) => a.start - b.start);
}

/** How long a line should take to say, from its word count. */
export function estimateSeconds(text: string, secondsPerWord: number): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return round(Math.max(1, words) * secondsPerWord);
}

/**
 * Places each line at its start, and freezes the picture wherever a line would run into the
 * next one (or past the end of the picture) for as long as it overruns. A freeze sits just
 * before the next line's start, so the action that goes with that line waits for it.
 */
export function schedule(lines: VoicedLine[], pictureSeconds: number) {
  const sorted = [...lines].sort((a, b) => a.start - b.start);
  const holds: Hold[] = [];
  sorted.forEach((line, i) => {
    const limit = i + 1 < sorted.length ? sorted[i + 1].start - LINE_GAP : pictureSeconds - 0.5;
    const overrun = line.start + line.seconds - limit;
    if (overrun > 0) {
      holds.push({ at: round(Math.max(line.start, limit - 0.1)), length: round(overrun + 0.1) });
    }
  });
  /** Where a moment of the silent picture is in the voiced one. */
  const shift = (t: number) =>
    round(t + holds.filter((h) => h.at <= t).reduce((sum, h) => sum + h.length, 0));
  const scheduled: ScheduledLine[] = sorted.map((l) => ({ ...l, at: shift(l.start) }));
  const seconds = round(pictureSeconds + holds.reduce((sum, h) => sum + h.length, 0));
  return { lines: scheduled, holds, shift, seconds };
}

/** The voiced picture's timeline: every anchor of the silent one, moved past the freezes. */
export function shiftTimeline(timeline: Timeline, shift: (t: number) => number): Timeline {
  return { anchors: timeline.anchors.map((a) => ({ ...a, t: shift(a.t) })) };
}

/** The lines with no recording, where they are in the voiced picture. */
export function unvoicedLines(lines: ScheduledLine[]): UnvoicedLine[] {
  return lines
    .filter((l) => !l.audio)
    .map((l) => ({ start: l.at, end: round(l.at + l.seconds), text: l.text }));
}

/** Subtitles for the voiced picture, each line shown while it's spoken and a little after. */
export function srt(lines: ScheduledLine[], totalSeconds: number): string {
  return lines
    .map((line, i) => {
      const next = i + 1 < lines.length ? lines[i + 1].at : totalSeconds;
      const end = Math.min(next - 0.05, line.at + line.seconds + 0.4);
      return `${i + 1}\n${srtStamp(line.at)} --> ${srtStamp(end)}\n${line.text}\n`;
    })
    .join("\n");
}

/** An SRT timestamp, such as 00:00:04,600. */
export function srtStamp(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
