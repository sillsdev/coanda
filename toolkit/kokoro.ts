// Recording narration lines with Kokoro, a free voice that runs on this computer, through the
// Python helper toolkit/python/kokoro_say.py. Kokoro isn't part of Howbench: the recipe's voice
// entry names the Python that has it ("python"), and a clear error says how to install it.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Alignment } from "./voiceCache.ts";

export const KOKORO_HELPER = fileURLToPath(new URL("./python/kokoro_say.py", import.meta.url));

/** The helper's exit code when Kokoro isn't installed. */
const MISSING = 3;

/** The Kokoro settings in a recipe's voice entry. */
export interface KokoroSettings {
  /** A Kokoro voice, such as "af_heart", or a blend, such as "af_heart,bf_emma". */
  voiceId?: string;
  /** Kokoro's `lang_code`, which picks the pronunciation: "a" American English, "b" British
   * English, "e" Spanish, "f" French, "h" Hindi, "i" Italian, "j" Japanese, "p" Brazilian
   * Portuguese, "z" Mandarin. Defaults to the voice name's first letter. */
  langCode?: string;
  /** Kokoro's `speed`: 1 is its normal pace. */
  speed?: number;
  /** The Python that has Kokoro installed. Defaults to `py` on Windows, else `python3`. */
  python?: string;
  /** [pattern, replacement] pairs applied to what Kokoro is told to say, never to the subtitles:
   * regular expressions, such as ["\\bsign language\\b", "[sign](-1) [language](+1)"]. Kokoro's
   * markup: [word](+1) or [word](-1) moves the stress, [word](/phonemes/) sets the sound. */
  markup?: [string, string][];
}

export interface KokoroLine {
  /** What Kokoro is told to say, with any markup. */
  spoken: string;
  /** Kokoro adds random noise; the same seed gives the same recording. */
  seed: number;
  /** The WAV file to write. */
  out: string;
}

export interface KokoroResult {
  out: string;
  /** When the speech ends. */
  seconds: number;
  /** Each word's start and end, where Kokoro gives them. */
  words: { text: string; start: number; end: number }[];
}

export const DEFAULT_KOKORO_VOICE = "af_heart";

export function kokoroVoice(settings: KokoroSettings): string {
  return settings.voiceId?.trim() || DEFAULT_KOKORO_VOICE;
}

/** The cache's model for a Kokoro recording: the pronunciation and pace, so a change to either
 * records the line again. */
export function kokoroModel(settings: KokoroSettings): string {
  const voice = kokoroVoice(settings);
  return `kokoro/${settings.langCode ?? voice[0]}/${settings.speed ?? 1}`;
}

/** The command that runs the helper. */
export function kokoroCommand(settings: KokoroSettings): string[] {
  const python = settings.python ?? (process.platform === "win32" ? "py" : "python3");
  return [python, KOKORO_HELPER];
}

/** What Kokoro is told to say for a line: the line with the recipe's markup applied. */
export function kokoroSpoken(text: string, markup: [string, string][] = []): string {
  return markup.reduce(
    (s, [pattern, replacement]) => s.replace(new RegExp(pattern, "gu"), replacement),
    text,
  );
}

/** A seed from the line's words, so a line sounds the same each time it's recorded. */
export function kokoroSeed(text: string): number {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.codePointAt(0)!, 16777619) >>> 0;
  return h % 2147483647;
}

/**
 * Says each line with Kokoro, all in one run of the helper so the model loads once. Calls
 * `onLine` as each line is finished.
 */
export async function speakKokoro(opts: {
  command: string[];
  settings: KokoroSettings;
  lines: KokoroLine[];
  onLine?: (result: KokoroResult, index: number) => void;
}): Promise<KokoroResult[]> {
  const [program, ...args] = opts.command;
  const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
  const results: KokoroResult[] = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => (stderr += d));
  const reading = (async () => {
    for await (const line of createInterface({ input: child.stdout })) {
      if (!line.trim().startsWith("{")) continue;
      const result = JSON.parse(line) as KokoroResult;
      opts.onLine?.(result, results.length);
      results.push(result);
    }
  })();
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  child.stdin.end(
    JSON.stringify({
      voice: kokoroVoice(opts.settings),
      ...(opts.settings.langCode ? { langCode: opts.settings.langCode } : {}),
      speed: opts.settings.speed ?? 1,
      lines: opts.lines,
    }),
    "utf8",
  );
  let code: number | null;
  try {
    code = await exited;
  } catch (err) {
    throw new Error(
      `Could not run ${program} for Kokoro. Set "python" in the recipe's voice entry to the ` +
        `Python that has Kokoro installed.`,
      { cause: err },
    );
  }
  await reading;
  if (code === MISSING) throw new Error(stderr.trim());
  if (code !== 0) {
    throw new Error(
      `Kokoro failed (exit ${code}):\n${stderr.trim().split("\n").slice(-15).join("\n")}`,
    );
  }
  if (results.length !== opts.lines.length) {
    throw new Error(`Kokoro said ${results.length} of ${opts.lines.length} lines`);
  }
  return results;
}

/**
 * Character timings for `text`, in the form ElevenLabs gives them, from Kokoro's word timings:
 * each word of the text takes the times of the matching word Kokoro reports, spread over its
 * letters. When the words don't match one for one (markup can change them), the letters are
 * spread evenly over the speech. The last letter ends at `seconds`, when the speech ends.
 */
export function alignmentFromWords(
  text: string,
  words: KokoroResult["words"],
  seconds: number,
): Alignment {
  const characters = Array.from(text);
  const starts = Array<number>(characters.length).fill(0);
  const ends = Array<number>(characters.length).fill(0);
  const textWords = wordSpans(characters);
  const spoken = words.filter((w) => wordKey(w.text));
  const spread = (from: number, to: number, a: number, b: number) => {
    for (let c = from; c < to; c++) {
      starts[c] = round(a + ((b - a) * (c - from)) / (to - from));
      ends[c] = round(a + ((b - a) * (c - from + 1)) / (to - from));
    }
  };
  if (textWords.length && textWords.length === spoken.length) {
    textWords.forEach(([from, to], k) => spread(from, to, spoken[k].start, spoken[k].end));
    // Spaces and the like between words: they start and end where the word before ended.
    let last = 0;
    for (let c = 0; c < characters.length; c++) {
      if (textWords.some(([from, to]) => c >= from && c < to)) last = ends[c];
      else starts[c] = ends[c] = last;
    }
  } else {
    spread(0, characters.length, 0, seconds);
  }
  if (characters.length) ends[characters.length - 1] = round(Math.max(ends.at(-1)!, seconds));
  return {
    characters,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  };
}

/** The [start, end) character spans of the words in a line that have letters or digits. */
function wordSpans(characters: string[]): [number, number][] {
  const spans: [number, number][] = [];
  let start = -1;
  for (let c = 0; c <= characters.length; c++) {
    const space = c === characters.length || /\s/u.test(characters[c]);
    if (!space && start < 0) start = c;
    if (space && start >= 0) {
      if (wordKey(characters.slice(start, c).join(""))) spans.push([start, c]);
      start = -1;
    }
  }
  return spans;
}

const wordKey = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const round = (n: number) => Math.round(n * 1000) / 1000;
