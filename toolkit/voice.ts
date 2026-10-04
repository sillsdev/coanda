// `coanda voice`: lays narration over a silent picture.
//
// It reads the picture's timeline, whose anchors with `say` are the narration lines, and gives
// each line a recording from the project's voice cache, matched by its words. A line with no
// recording gets a gap as long as it should take to say, so the picture keeps its timing; only
// a voice pass records new lines, because recording costs money. Where a line runs into the
// next one, the picture freezes for the difference.
//
// It writes, beside the output video: `<name>.srt`, `<name>.timeline.json` (the timeline moved
// past the freezes) and `<name>.voice.json` (each line, and the lines still unvoiced).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, parse, resolve } from "node:path";
import type { Timeline, UnvoicedLine } from "../shared/types.ts";
import { PROJECT_FILE } from "../server/store.ts";
import { elevenLabsKey, speak } from "./elevenlabs.ts";
import { findRecipe } from "./recipe.ts";
import { duration, ffmpeg } from "./ffmpeg.ts";
import { findRecording, readCache, saveRecording } from "./voiceCache.ts";
import {
  estimateSeconds,
  narrationLines,
  schedule,
  shiftTimeline,
  srt,
  unvoicedLines,
  type Hold,
  type VoicedLine,
} from "./voicePlan.ts";

/** The `voice` entry of a project's video-project.json. */
export interface VoiceSettings {
  provider?: "elevenlabs";
  voiceId?: string;
  model?: string;
  /** The cache folder, relative to the project folder. */
  cache?: string;
  /** How long a word takes to say in this voice; sizes the gaps left for unvoiced lines. */
  secondsPerWord?: number;
  pricePer1000Characters?: number;
  currency?: string;
  /** The narration's language, as an ISO 639-2 code such as "eng", for the subtitle track. */
  language?: string;
}

export type VoiceMode = "reuse" | "pass" | "plan";

/** What `<name>.voice.json` holds. */
export interface VoiceReport {
  picture: string;
  lines: {
    key: string;
    text: string;
    at: number;
    seconds: number;
    recording: string | null;
  }[];
  holds: Hold[];
  unvoiced: UnvoicedLine[];
}

/** What a voice pass would record, and what it would cost. */
export interface VoicePlan {
  lines: { key: string; text: string; recorded: boolean }[];
  toRecord: number;
  characters: number;
  /** Null when the recipe gives no price. */
  cost: number | null;
  currency: string | null;
}

const DEFAULT_SECONDS_PER_WORD = 0.43;

/** The folder holding video-project.json, at or above `dir`, and its voice settings. */
export function findVoiceSettings(dir: string): { projectDir: string; settings: VoiceSettings } {
  const { projectDir, recipe } = findRecipe(dir);
  return { projectDir, settings: (recipe.voice as VoiceSettings | undefined) ?? {} };
}

export async function voice(opts: {
  picture: string;
  out: string;
  /** Defaults to `<picture name>.timeline.json` beside the picture. */
  timeline?: string;
  mode: VoiceMode;
  log?: (line: string) => void;
}): Promise<VoiceReport | VoicePlan> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const picture = resolve(opts.picture);
  const pic = parse(picture);
  const timelinePath = resolve(opts.timeline ?? join(pic.dir, `${pic.name}.timeline.json`));
  if (!existsSync(timelinePath)) {
    throw new Error(`No timeline for the picture at ${timelinePath}`);
  }
  const out = resolve(opts.out);
  const o = parse(out);
  const outTimeline = join(o.dir, `${o.name}.timeline.json`);
  if (opts.mode !== "plan" && (out === picture || outTimeline === timelinePath)) {
    throw new Error(`${out} would overwrite the picture or the timeline it's made from`);
  }
  const timeline = JSON.parse(readFileSync(timelinePath, "utf8")) as Timeline;
  const lines = narrationLines(timeline);
  if (!lines.length) throw new Error(`The timeline ${timelinePath} has no anchors with "say"`);

  const { projectDir, settings } = findVoiceSettings(pic.dir);
  const cacheDir = resolve(projectDir, settings.cache ?? "voice-cache");
  const cache = readCache(cacheDir);
  const perWord = settings.secondsPerWord ?? DEFAULT_SECONDS_PER_WORD;
  const found = lines.map((l) => findRecording(cache, l.text, settings.voiceId, settings.model));

  if (opts.mode === "plan") {
    const missing = lines.filter((_, i) => !found[i]);
    const characters = missing.reduce((n, l) => n + l.text.length, 0);
    const price = settings.pricePer1000Characters;
    return {
      lines: lines.map((l, i) => ({ key: l.key, text: l.text, recorded: Boolean(found[i]) })),
      toRecord: missing.length,
      characters,
      cost: typeof price === "number" ? Math.round((characters / 1000) * price * 100) / 100 : null,
      currency: settings.currency ?? null,
    };
  }

  const voiced: VoicedLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let rec = found[i];
    if (!rec && opts.mode === "pass") {
      const apiKey = elevenLabsKey();
      if (!apiKey) throw new Error("No ElevenLabs key: set one in Coanda's settings");
      if (!settings.voiceId || !settings.model) {
        throw new Error(`Set voice.voiceId and voice.model in ${PROJECT_FILE}`);
      }
      const spoken = await speak({
        apiKey,
        voiceId: settings.voiceId,
        model: settings.model,
        text: line.text,
        previous: lines[i - 1]?.text ?? "",
        next: lines[i + 1]?.text ?? "",
      });
      rec = saveRecording(
        cacheDir,
        {
          provider: "elevenlabs",
          voice: settings.voiceId,
          model: settings.model,
          text: line.text,
          previous: lines[i - 1]?.text ?? "",
          next: lines[i + 1]?.text ?? "",
          alignment: spoken.alignment,
        },
        spoken.audio,
      );
      cache.push(rec);
      log(`recorded: ${line.text}`);
    }
    voiced.push(
      rec
        ? { ...line, audio: rec.audio, seconds: rec.seconds }
        : { ...line, seconds: estimateSeconds(line.text, perWord) },
    );
  }

  const pictureSeconds = duration(picture);
  const plan = schedule(voiced, pictureSeconds);
  const srtPath = join(o.dir, `${o.name}.srt`);
  writeFileSync(srtPath, srt(plan.lines, plan.seconds), "utf8");
  render(picture, out, srtPath, plan, settings.language);

  const report: VoiceReport = {
    picture,
    lines: plan.lines.map((l) => ({
      key: l.key,
      text: l.text,
      at: l.at,
      seconds: l.seconds,
      recording: l.audio ?? null,
    })),
    holds: plan.holds,
    unvoiced: unvoicedLines(plan.lines),
  };
  writeFileSync(outTimeline, JSON.stringify(shiftTimeline(timeline, plan.shift), null, 1));
  writeFileSync(join(o.dir, `${o.name}.voice.json`), JSON.stringify(report, null, 1));
  log(
    `${out} (${plan.seconds.toFixed(2)} s): ${lines.length} lines, ` +
      `${report.unvoiced.length} unvoiced, ${plan.holds.length} freezes`,
  );
  return report;
}

/** Cuts the picture at each freeze and holds its frame, mixes in the recordings, and adds the
 * subtitles as a track. */
function render(
  picture: string,
  out: string,
  srtPath: string,
  plan: ReturnType<typeof schedule>,
  language: string | undefined,
): void {
  const { holds, lines, seconds } = plan;
  const pictureSeconds = seconds - holds.reduce((n, h) => n + h.length, 0);
  const cuts = [0, ...holds.map((h) => h.at), pictureSeconds];
  const filters: string[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const pad = k < holds.length ? `,tpad=stop_mode=clone:stop_duration=${holds[k].length}` : "";
    filters.push(`[0:v]trim=start=${cuts[k]}:end=${cuts[k + 1]},setpts=PTS-STARTPTS${pad}[v${k}]`);
  }
  const parts = cuts.length - 1;
  filters.push(
    `${Array.from({ length: parts }, (_, k) => `[v${k}]`).join("")}concat=n=${parts}:v=1:a=0[v]`,
  );

  const recorded = lines.filter((l) => l.audio);
  if (recorded.length) {
    recorded.forEach((l, k) =>
      filters.push(`[${k + 1}:a]adelay=${Math.round(l.at * 1000)}:all=1[a${k}]`),
    );
    filters.push(
      `${recorded.map((_, k) => `[a${k}]`).join("")}amix=inputs=${recorded.length}:normalize=0:duration=longest,` +
        `apad=whole_dur=${seconds.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]`,
    );
  } else {
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${seconds.toFixed(3)}[a]`);
  }

  const subtitleInput = recorded.length + 1;
  ffmpeg([
    "-i",
    picture,
    ...recorded.flatMap((l) => ["-i", l.audio!]),
    "-i",
    srtPath,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-map",
    `${subtitleInput}:s`,
    "-c:v",
    "libx264",
    "-crf",
    "17",
    "-preset",
    "medium",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-c:s",
    "mov_text",
    "-metadata:s:s:0",
    "title=Narration",
    ...(language ? ["-metadata:s:s:0", `language=${language}`] : []),
    "-t",
    seconds.toFixed(3),
    "-movflags",
    "+faststart",
    out,
  ]);
}
