// Recordings of narration lines, kept so a line is only paid for once.
//
// Each recording is a pair of files in the cache folder: `<hash>.mp3` and `<hash>.json`. The hash
// is of the provider, voice, model and the line's words without final punctuation, so "pages,"
// and "pages." share a recording, and a change to a neighbouring line doesn't make a new one.
// The JSON holds the exact text, the neighbouring lines sent as context, and the provider's
// character timings. Older caches hold only the timings (`characters`,
// `character_end_times_seconds`), with the voice unrecorded; they are still used.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

export interface CacheEntry {
  provider: string;
  voice: string;
  model: string;
  text: string;
  previous: string;
  next: string;
  alignment: Alignment;
  /** What the provider was given to say, when it differs from `text`, such as Kokoro's
   * pronunciation markup. */
  spoken?: string;
}

export interface Recording {
  audio: string;
  text: string;
  /** When the speech ends, a little before the end of the audio's trailing silence. */
  seconds: number;
  /** Absent for recordings from older caches, which didn't record them. */
  voice?: string;
  model?: string;
  provider?: string;
  spoken?: string;
}

/** A line's words for matching recordings: trimmed, spaces collapsed, final punctuation off. */
export function sameWords(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\s.,;:!?…]+$/u, "");
}

/** Every recording in a cache folder. */
export function readCache(dir: string): Recording[] {
  if (!existsSync(dir)) return [];
  const out: Recording[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const audio = join(dir, file.replace(/\.json$/, ".mp3"));
    if (!existsSync(audio)) continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as
        | CacheEntry
        | (Alignment & { text?: undefined });
      const alignment = "alignment" in data ? data.alignment : data;
      const text = "alignment" in data ? data.text : alignment.characters.join("");
      const seconds = alignment.character_end_times_seconds.at(-1) ?? 0;
      out.push({
        audio,
        text,
        seconds,
        ...("alignment" in data
          ? {
              voice: data.voice,
              model: data.model,
              provider: data.provider,
              ...(data.spoken !== undefined ? { spoken: data.spoken } : {}),
            }
          : {}),
      });
    } catch {
      // Not a recording's data; ignore it.
    }
  }
  return out;
}

/**
 * A recording of the same words in this voice: one made with this provider, voice and model if
 * there is one, otherwise, for ElevenLabs, one from an older cache that didn't record its voice
 * (those were all ElevenLabs).
 */
export function findRecording(
  cache: Recording[],
  text: string,
  voice: string | undefined,
  model: string | undefined,
  provider = "elevenlabs",
): Recording | undefined {
  const words = sameWords(text);
  const same = cache.filter((r) => sameWords(r.text) === words);
  const exact = same.find(
    (r) =>
      r.voice !== undefined &&
      r.voice === voice &&
      r.model === model &&
      (r.provider ?? "elevenlabs") === provider,
  );
  if (exact || provider !== "elevenlabs") return exact;
  // Older ElevenLabs recordings name no voice; never fall back to another provider's.
  const elevenLabs = same.filter((r) => (r.provider ?? "elevenlabs") === "elevenlabs");
  return (
    elevenLabs.find((r) => r.voice === undefined) ??
    (voice === undefined ? elevenLabs[0] : undefined)
  );
}

/** The character timings saved with a recording, if its data file has them. */
export function readAlignment(audio: string): Alignment | undefined {
  const file = audio.replace(/\.mp3$/, ".json");
  if (!existsSync(file)) return undefined;
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as CacheEntry | Alignment;
    return "alignment" in data ? data.alignment : data;
  } catch {
    return undefined;
  }
}

/** Saves a new recording and returns it. */
export function saveRecording(dir: string, entry: CacheEntry, audio: Buffer): Recording {
  mkdirSync(dir, { recursive: true });
  const hash = createHash("sha1")
    .update([entry.provider, entry.voice, entry.model, sameWords(entry.text)].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
  const file = join(dir, `${hash}.mp3`);
  writeFileSync(file, audio);
  writeFileSync(join(dir, `${hash}.json`), JSON.stringify(entry, null, 1));
  return {
    audio: file,
    text: entry.text,
    seconds: entry.alignment.character_end_times_seconds.at(-1) ?? 0,
    voice: entry.voice,
    model: entry.model,
    provider: entry.provider,
    ...(entry.spoken !== undefined ? { spoken: entry.spoken } : {}),
  };
}
