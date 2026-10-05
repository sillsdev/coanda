// Subtitles in another language, for reviewers who read it better than the narration's, in
// short phrases: each phrase appears when the narration reaches the phrase's first word and
// stays until the next phrase.
//
// The translation is a JSON file of [narration phrase, translation] pairs, in narration order:
//   [["In this video,", "En este video,"], ["we'll use a template", "usaremos una plantilla"], ...]
// The narration phrases, put together, must be the narration lines word for word (punctuation
// and case don't matter), and a phrase may not run from one line into the next.
//
// A phrase's start comes from the recording's character timings when the line has a recording,
// and otherwise from where its first letter falls in the line, as a share of the line's length.
import { readFileSync, writeFileSync } from "node:fs";
import { srtStamp } from "./voicePlan.ts";
import { readAlignment, type Alignment } from "./voiceCache.ts";
import type { VoiceReport } from "./voice.ts";

export type PhrasePair = [phrase: string, translation: string];

/** A narration line where it is in the video. */
export interface TimedLine {
  text: string;
  at: number;
  seconds: number;
  /** The recording's character timings, if it has them. */
  alignment?: Alignment;
}

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** A phrase shows for at least this long, unless the next phrase comes sooner. */
const MIN_CUE = 0.6;

/** Reads a file of [narration phrase, translation] pairs. */
export function readPhrasePairs(file: string): PhrasePair[] {
  const data = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as unknown;
  if (
    !Array.isArray(data) ||
    !data.every((p) => Array.isArray(p) && p.length === 2 && p.every((s) => typeof s === "string"))
  ) {
    throw new Error(`${file} must be a list of [narration phrase, translation] pairs`);
  }
  return data as PhrasePair[];
}

/** One cue per phrase, timed from the lines. Throws, naming the line, when the phrases don't
 * add up to the narration. */
export function phraseCues(lines: TimedLine[], pairs: PhrasePair[]): Cue[] {
  const cues: Cue[] = [];
  let p = 0;
  lines.forEach((line, i) => {
    const words = wordSpans(line.text);
    const recorded = line.alignment && wordSpans(line.alignment.characters.join(""));
    const starts: { at: number; translation: string }[] = [];
    let w = 0;
    while (w < words.length) {
      const pair = pairs[p];
      if (!pair) {
        throw new Error(
          `No translation for the words from "${words[w].text}" on, in the line "${line.text}"`,
        );
      }
      const phrase = wordSpans(pair[0]).map((s) => s.word);
      if (!phrase.length) throw new Error(`The phrase "${pair[0]}" has no words`);
      const found = words.slice(w, w + phrase.length).map((s) => s.word);
      if (found.join(" ") !== phrase.join(" ")) {
        const runsOn = found.length < phrase.length && phrase.join(" ").startsWith(found.join(" "));
        throw new Error(
          runsOn
            ? `The phrase "${pair[0]}" runs past the end of the line "${line.text}"`
            : `The phrase "${pair[0]}" doesn't match the line "${line.text}" at "${words
                .slice(w, w + phrase.length)
                .map((s) => s.text)
                .join(" ")}"`,
        );
      }
      starts.push({ at: phraseStart(line, words, recorded, w), translation: pair[1] });
      w += phrase.length;
      p++;
    }
    const next = lines[i + 1]?.at ?? Infinity;
    const lineEnd = Math.min(next - 0.05, line.at + line.seconds + 0.4);
    starts.forEach((s, k) => {
      const end =
        k + 1 < starts.length
          ? starts[k + 1].at - 0.04
          : Math.max(lineEnd, Math.min(s.at + MIN_CUE, next - 0.05));
      cues.push({ start: round(s.at), end: round(end), text: s.translation });
    });
  });
  if (p < pairs.length) {
    throw new Error(`The phrase "${pairs[p][0]}" comes after the last narration line`);
  }
  return cues;
}

/** Where the phrase that starts at the line's `w`th word starts in the video. */
function phraseStart(
  line: TimedLine,
  words: WordSpan[],
  recorded: WordSpan[] | undefined,
  w: number,
): number {
  if (w === 0) return line.at;
  if (line.alignment && recorded && recorded.length === words.length) {
    const t = line.alignment.character_start_times_seconds[recorded[w].from];
    if (Number.isFinite(t)) return line.at + t;
  }
  return line.at + (line.seconds * words[w].from) / Math.max(1, Array.from(line.text).length);
}

/** Cues as an SRT file, with a byte-order mark so players read it as UTF-8. */
export function cuesToSrt(cues: Cue[]): string {
  return (
    "﻿" +
    cues
      .map((c, i) => `${i + 1}\n${srtStamp(c.start)} --> ${srtStamp(c.end)}\n${c.text}\n`)
      .join("\n")
  );
}

/** The lines of a voice report (`<name>.voice.json`), with their recordings' timings. */
export function linesFromReport(report: Pick<VoiceReport, "lines">): TimedLine[] {
  return report.lines.map((l) => {
    const alignment = l.recording ? readAlignment(l.recording) : undefined;
    return { text: l.text, at: l.at, seconds: l.seconds, ...(alignment ? { alignment } : {}) };
  });
}

/** Writes the translated subtitles for a video from its voice report (or the report's file,
 * `<name>.voice.json`) and a file of pairs. */
export function writeTranslatedSubtitles(opts: {
  report: string | Pick<VoiceReport, "lines">;
  pairs: string;
  out: string;
}): Cue[] {
  const report =
    typeof opts.report === "string"
      ? (JSON.parse(readFileSync(opts.report, "utf8")) as VoiceReport)
      : opts.report;
  const cues = phraseCues(linesFromReport(report), readPhrasePairs(opts.pairs));
  writeFileSync(opts.out, cuesToSrt(cues), "utf8");
  return cues;
}

interface WordSpan {
  /** The word as written. */
  text: string;
  /** The word for matching: lower case, letters and digits only. */
  word: string;
  /** Where it starts in the line, in characters. */
  from: number;
}

/** The words of a text that have letters or digits, with where each starts. */
function wordSpans(text: string): WordSpan[] {
  const characters = Array.from(text.normalize("NFC"));
  const spans: WordSpan[] = [];
  let start = -1;
  for (let c = 0; c <= characters.length; c++) {
    const space = c === characters.length || /\s/u.test(characters[c]);
    if (!space && start < 0) start = c;
    if (space && start >= 0) {
      const raw = characters.slice(start, c).join("");
      const word = raw.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      if (word) spans.push({ text: raw, word, from: start });
      start = -1;
    }
  }
  return spans;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
