import { expect, test } from "vite-plus/test";
import { cuesToSrt, phraseCues, type TimedLine } from "./translatedSubtitles.ts";

const evenly = (text: string, seconds: number) => {
  const characters = Array.from(text);
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => (seconds * i) / characters.length),
    character_end_times_seconds: characters.map((_, i) => (seconds * (i + 1)) / characters.length),
  };
};

test("a phrase starts with its first word in the recording", () => {
  const text = "Click Basic Book, then click Make.";
  const lines: TimedLine[] = [
    // The recording's text may differ in final punctuation from the line's.
    { text, at: 10, seconds: 3.4, alignment: evenly("Click Basic Book, then click Make", 3.3) },
    { text: "Done.", at: 15, seconds: 1 },
  ];
  const cues = phraseCues(lines, [
    ["Click Basic Book,", "Haz clic en Libro básico,"],
    ["then click Make.", "y luego en Crear."],
    ["Done.", "Listo."],
  ]);
  // "then" is the 19th character of 33, which the recording starts at 18/33 * 3.3 s.
  expect(cues).toEqual([
    { start: 10, end: 11.76, text: "Haz clic en Libro básico," },
    { start: 11.8, end: 13.8, text: "y luego en Crear." },
    { start: 15, end: 16.4, text: "Listo." },
  ]);
});

test("without a recording, a phrase starts at its share of the line", () => {
  const cues = phraseCues(
    [{ text: "abcd efgh", at: 2, seconds: 0.18 }],
    [
      ["ABCD", "uno"],
      ["efgh", "dos"],
    ],
  );
  expect(cues.map((c) => c.start)).toEqual([2, 2.1]);
  // The last phrase is shown for at least 0.6 s.
  expect(cues[1].end).toBe(2.7);
});

test("phrases that don't add up to the narration are refused", () => {
  const lines: TimedLine[] = [
    { text: "One two.", at: 0, seconds: 1 },
    { text: "Three.", at: 2, seconds: 1 },
  ];
  expect(() => phraseCues(lines, [["One two three", "x"]])).toThrow(/runs past the end/);
  expect(() => phraseCues(lines, [["One too", "x"]])).toThrow(/doesn't match the line "One two."/);
  expect(() => phraseCues(lines, [["One two", "x"]])).toThrow(
    /No translation for the words from "Three."/,
  );
  expect(() =>
    phraseCues(lines, [
      ["One two", "x"],
      ["Three", "y"],
      ["Four", "z"],
    ]),
  ).toThrow(/after the last narration line/);
});

test("the subtitle file is SRT with a byte-order mark", () => {
  expect(cuesToSrt([{ start: 1, end: 2.5, text: "Hola" }])).toBe(
    "﻿1\n00:00:01,000 --> 00:00:02,500\nHola\n",
  );
});
