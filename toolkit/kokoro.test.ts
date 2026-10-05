import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import {
  alignmentFromWords,
  KOKORO_HELPER,
  kokoroModel,
  kokoroSeed,
  kokoroSpoken,
  speakKokoro,
} from "./kokoro.ts";

test("markup changes only what Kokoro is told to say", () => {
  const markup: [string, string][] = [["\\bsign language\\b", "[sign](-1) [language](+1)"]];
  expect(kokoroSpoken("Use sign language here.", markup)).toBe(
    "Use [sign](-1) [language](+1) here.",
  );
  expect(kokoroSpoken("No markup.", [])).toBe("No markup.");
});

test("the cache's model for Kokoro holds the pronunciation and pace", () => {
  expect(kokoroModel({ voiceId: "bf_emma" })).toBe("kokoro/b/1");
  expect(kokoroModel({ voiceId: "af_heart,bf_emma", langCode: "b", speed: 0.97 })).toBe(
    "kokoro/b/0.97",
  );
  expect(kokoroModel({})).toBe("kokoro/a/1");
});

test("a line's seed comes from its words", () => {
  expect(kokoroSeed("Click it.")).toBe(kokoroSeed("Click it."));
  expect(kokoroSeed("Click it.")).not.toBe(kokoroSeed("Click it again."));
});

test("character timings follow Kokoro's words when they match the line's", () => {
  const a = alignmentFromWords(
    "Hi, you.",
    [
      { text: "Hi", start: 0.1, end: 0.3 },
      { text: ",", start: 0.3, end: 0.35 },
      { text: "you", start: 0.5, end: 0.9 },
      { text: ".", start: 0.9, end: 0.9 },
    ],
    1,
  );
  expect(a.characters.join("")).toBe("Hi, you.");
  expect(a.character_start_times_seconds[0]).toBe(0.1);
  expect(a.character_start_times_seconds[4]).toBe(0.5);
  // The space starts and ends where "Hi," ended.
  expect(a.character_start_times_seconds[3]).toBe(0.3);
  expect(a.character_end_times_seconds.at(-1)).toBe(1);
});

test("without matching words, the letters are spread over the speech", () => {
  const a = alignmentFromWords("abcd", [], 2);
  expect(a.character_start_times_seconds).toEqual([0, 0.5, 1, 1.5]);
  expect(a.character_end_times_seconds.at(-1)).toBe(2);
});

/** A stand-in for the Python helper, run by Node: it says each line as an empty file. */
const fakeHelper = (dir: string, body: string) => {
  const file = join(dir, "fake.mjs");
  writeFileSync(file, body);
  return [process.execPath, file];
};

test("speakKokoro sends the lines and reads back one result per line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "howreel-kokoro-"));
  const command = fakeHelper(
    dir,
    `import { readFileSync, writeFileSync } from "node:fs";
const req = JSON.parse(readFileSync(0, "utf8"));
writeFileSync(${JSON.stringify(join(dir, "request.json"))}, JSON.stringify(req));
console.log("loading the model");
for (const l of req.lines) {
  writeFileSync(l.out, "");
  console.log(JSON.stringify({ out: l.out, seconds: 1.5, words: [{ text: "Hi", start: 0, end: 1 }] }));
}`,
  );
  const seen: number[] = [];
  const results = await speakKokoro({
    command,
    settings: { voiceId: "bf_emma", speed: 0.9 },
    lines: [
      { spoken: "Hi.", seed: 1, out: join(dir, "a.wav") },
      { spoken: "Hé, là.", seed: 2, out: join(dir, "b.wav") },
    ],
    onLine: (_, k) => seen.push(k),
  });
  expect(results.map((r) => r.seconds)).toEqual([1.5, 1.5]);
  expect(seen).toEqual([0, 1]);
  expect(existsSync(join(dir, "b.wav"))).toBe(true);
  const request = JSON.parse(readFileSync(join(dir, "request.json"), "utf8"));
  expect(request.voice).toBe("bf_emma");
  expect(request.speed).toBe(0.9);
  expect(request.lines[1].spoken).toBe("Hé, là.");
});

test("speakKokoro passes on the helper's install instructions when Kokoro is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "howreel-kokoro-"));
  const command = fakeHelper(
    dir,
    `process.stdin.resume(); process.stdin.on("end", () => { console.error("Kokoro isn't installed. Install it: pip install kokoro"); process.exit(3); });`,
  );
  await expect(
    speakKokoro({ command, settings: {}, lines: [{ spoken: "Hi.", seed: 1, out: "x.wav" }] }),
  ).rejects.toThrow(/pip install kokoro/);
});

// The Python helper itself, with stand-ins for kokoro and torch, where Python is installed.
const python = process.platform === "win32" ? "py" : "python3";
const hasPython = spawnSync(python, ["--version"]).status === 0;

const runHelper = (stubs: Record<string, string>, request: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "howreel-kokoro-py-"));
  for (const [name, code] of Object.entries(stubs)) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "__init__.py"), code);
  }
  const result = spawnSync(python, [KOKORO_HELPER], {
    input: JSON.stringify(request),
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: dir, PYTHONIOENCODING: "utf-8" },
  });
  return { ...result, dir };
};

const TORCH = "def manual_seed(n):\n    pass\n";
const KOKORO = `
class Token:
    def __init__(self, text, start, end):
        self.text, self.start_ts, self.end_ts = text, start, end

class Result:
    def __init__(self, text):
        self.audio = [0.0] * 2400 + [0.5, -0.5] * 2400 + [0.0] * 2400
        self.tokens = [Token(w, 0.1, 0.3) for w in text.split()]

class KPipeline:
    def __init__(self, lang_code):
        self.lang_code = lang_code
    def __call__(self, text, voice, speed):
        yield Result(text)
`;

test.skipIf(!hasPython)("the helper writes a WAV and word timings for each line", () => {
  const out = join(mkdtempSync(join(tmpdir(), "howreel-kokoro-out-")), "line.wav");
  const r = runHelper(
    { torch: TORCH, kokoro: KOKORO },
    { voice: "af_heart", lines: [{ spoken: "One two. Three.", seed: 5, out }] },
  );
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  const result = JSON.parse(r.stdout.trim());
  expect(existsSync(out)).toBe(true);
  // Two sentences of 0.4 s each, with 0.18 s between them.
  expect(result.duration).toBe(0.98);
  expect(result.words.map((w: { text: string }) => w.text)).toEqual(["One", "two.", "Three."]);
  expect(result.words[2].start).toBe(0.68);
  // The speech ends at the last loud sample, plus 0.05 s.
  expect(result.seconds).toBeCloseTo(0.93, 2);
});

test.skipIf(!hasPython)("the helper says what's wrong with a bad request", () => {
  const r = runHelper({ torch: TORCH, kokoro: KOKORO }, { voice: "af_heart", lines: [{}] });
  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(/line 1 needs "spoken"/);
});

test.skipIf(!hasPython)("the helper says how to install Kokoro when it's missing", () => {
  const r = runHelper(
    { torch: TORCH, kokoro: "raise ImportError(\"No module named 'kokoro'\")\n" },
    { voice: "af_heart", lines: [{ spoken: "Hi.", out: "x.wav" }] },
  );
  expect(r.status).toBe(3);
  expect(r.stderr).toMatch(/pip install kokoro/);
});
