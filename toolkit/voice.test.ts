import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { usableRecording, voice, voiceProvider, type VoicePlan } from "./voice.ts";
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
  const dir = mkdtempSync(join(tmpdir(), "howbench-voice-"));
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

test("the voiced timeline moves the pointer, presses and keys past the freezes too", () => {
  const shift = (t: number) => (t >= 4 ? t + 1 : t);
  const moved = shiftTimeline(
    {
      anchors: [],
      pointer: [
        { t: 3, x: 1, y: 2 },
        { t: 5, x: 3, y: 4 },
      ],
      presses: [{ t: 4, x: 3, y: 4 }],
      keys: [3.5, 4.5],
    },
    shift,
  );
  expect(moved.pointer).toEqual([
    { t: 3, x: 1, y: 2 },
    { t: 6, x: 3, y: 4 },
  ]);
  expect(moved.presses).toEqual([{ t: 5, x: 3, y: 4 }]);
  expect(moved.keys).toEqual([3.5, 5.5]);
  expect(shiftTimeline({ anchors: [] }, shift)).toEqual({ anchors: [] });
});

test("the provider is ElevenLabs unless the recipe says Kokoro", () => {
  expect(voiceProvider({})).toBe("elevenlabs");
  expect(voiceProvider({ provider: "kokoro" })).toBe("kokoro");
  expect(() => voiceProvider({ provider: "piper" as "kokoro" })).toThrow(/must be/);
});

test("a recording in one provider's voice isn't used for another's", () => {
  const dir = mkdtempSync(join(tmpdir(), "howbench-voice-"));
  writeFileSync(join(dir, "old.mp3"), "");
  writeFileSync(join(dir, "old.json"), JSON.stringify(alignment("Old line.", 1)));
  const kokoro = { provider: "kokoro" as const, voiceId: "af_heart" };
  saveRecording(
    dir,
    {
      provider: "kokoro",
      voice: "af_heart",
      model: "kokoro/a/1",
      text: "Use sign language.",
      previous: "",
      next: "",
      alignment: alignment("Use sign language.", 1),
      spoken: "Use [sign](-1) [language](+1).",
    },
    Buffer.from(""),
  );
  const cache = readCache(dir);
  // Older recordings without a voice are ElevenLabs ones.
  expect(usableRecording(cache, "Old line.", kokoro)).toBeUndefined();
  expect(usableRecording(cache, "Old line.", { voiceId: "x", model: "m" })).toBeDefined();
  expect(findRecording(cache, "Use sign language.", "af_heart", "kokoro/a/1")).toBeUndefined();
  // A Kokoro recording is used only while the markup says the same.
  const markup: [string, string][] = [["\\bsign language\\b", "[sign](-1) [language](+1)"]];
  expect(usableRecording(cache, "Use sign language.", { ...kokoro, markup })).toBeDefined();
  expect(usableRecording(cache, "Use sign language.", kokoro)).toBeUndefined();
});

test("a voice pass with Kokoro costs nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "howbench-voice-"));
  writeFileSync(
    join(dir, "video-project.json"),
    JSON.stringify({ voice: { provider: "kokoro", voiceId: "af_heart", cache: "cache" } }),
  );
  mkdirSync(join(dir, "drafts"));
  writeFileSync(
    join(dir, "drafts", "silent.timeline.json"),
    JSON.stringify({ anchors: [{ key: "a", t: 1, say: "Click it." }] }),
  );
  const plan = (await voice({
    picture: join(dir, "drafts", "silent.mp4"),
    out: "",
    mode: "plan",
  })) as VoicePlan;
  expect(plan).toMatchObject({
    provider: "kokoro",
    toRecord: 1,
    characters: 9,
    cost: 0,
    currency: null,
  });
});
