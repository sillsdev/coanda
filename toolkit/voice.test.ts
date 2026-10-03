import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { findRecording, readCache, saveRecording, sameWords } from "./voiceCache.ts";
import { narrationLines, schedule, shiftTimeline, srt, unvoicedLines } from "./voicePlan.ts";

const alignment = (text: string, seconds: number) => {
  const characters = text.split("");
  return {
    characters,
    character_start_times_seconds: characters.map(() => 0),
    character_end_times_seconds: characters.map((_, i) => (seconds * (i + 1)) / characters.length),
  };
};

test("narration lines are the anchors with words to say, in time order", () => {
  const lines = narrationLines({
    anchors: [
      { key: "line: two", t: 5, say: "Two." },
      { key: "click: Add Page", t: 3 },
      { key: "line: one", t: 1, say: " One. " },
    ],
  });
  expect(lines).toEqual([
    { key: "line: one", text: "One.", start: 1 },
    { key: "line: two", text: "Two.", start: 5 },
  ]);
});

test("a line that runs into the next freezes the picture just before the next one", () => {
  const plan = schedule(
    [
      { key: "a", text: "A", start: 0, seconds: 6, audio: "a.mp3" },
      { key: "b", text: "B", start: 5, seconds: 2, audio: "b.mp3" },
    ],
    10,
  );
  // a must end by 4.75; it overruns by 1.25 and the hold adds 0.1 to land before b's action.
  expect(plan.holds).toEqual([{ at: 4.65, length: 1.35 }]);
  expect(plan.lines.map((l) => l.at)).toEqual([0, 6.35]);
  expect(plan.seconds).toBe(11.35);
  // Moments before the freeze stay; moments after move with it.
  const moved = shiftTimeline(
    {
      anchors: [
        { key: "click", t: 3 },
        { key: "b", t: 5, say: "B" },
      ],
    },
    plan.shift,
  );
  expect(moved.anchors).toEqual([
    { key: "click", t: 3 },
    { key: "b", t: 6.35, say: "B" },
  ]);
});

test("a line with no recording leaves a gap and is listed as unvoiced", () => {
  const plan = schedule(
    [
      { key: "a", text: "A", start: 1, seconds: 2, audio: "a.mp3" },
      { key: "b", text: "B is new", start: 4, seconds: 1.3 },
    ],
    8,
  );
  expect(plan.holds).toEqual([]);
  expect(unvoicedLines(plan.lines)).toEqual([{ start: 4, end: 5.3, text: "B is new" }]);
  expect(srt(plan.lines, plan.seconds)).toBe(
    "1\n00:00:01,000 --> 00:00:03,400\nA\n\n2\n00:00:04,000 --> 00:00:05,700\nB is new\n",
  );
});

test("recordings match by words, ignoring final punctuation and spacing", () => {
  expect(sameWords("  We typed on the  pages, ")).toBe(sameWords("We typed on the pages."));
  expect(sameWords("Click it.")).not.toBe(sameWords("Click it again."));
});

test("the cache finds recordings in this voice, or from an older cache with no voice", () => {
  const dir = mkdtempSync(join(tmpdir(), "coanda-voice-"));
  // An older cache entry: only the timings.
  writeFileSync(join(dir, "old.mp3"), "");
  writeFileSync(join(dir, "old.json"), JSON.stringify(alignment("Basic Book.", 1.2)));
  const entry = (text: string, voice: string) => ({
    provider: "elevenlabs",
    voice,
    model: "m",
    text,
    previous: "",
    next: "",
    alignment: alignment(text, 2),
  });
  saveRecording(dir, entry("Click it.", "matilda"), Buffer.from(""));
  saveRecording(dir, entry("Other voice.", "george"), Buffer.from(""));

  const cache = readCache(dir);
  expect(findRecording(cache, "Basic Book,", "matilda", "m")?.seconds).toBe(1.2);
  expect(findRecording(cache, "Click it", "matilda", "m")?.voice).toBe("matilda");
  expect(findRecording(cache, "Other voice.", "matilda", "m")).toBeUndefined();
  expect(findRecording(cache, "Never said.", "matilda", "m")).toBeUndefined();
});
