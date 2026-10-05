// The narration track of a video, made from the silent picture and its timeline, whose anchors
// with `say` are the narration lines.
//
// `howreel subtitles` (mode "silent") makes the draft: no audio, each line shown as a subtitle
// for as long as it should take to say. `howreel voice` (modes "plan" and "pass") is the voice
// pass the reviewer asks for at the end: "plan" says what it would record and cost, "pass"
// records each line, keeping any recording already made of the same words. Where a line runs
// into the next one, the picture freezes for the difference.
//
// The voice comes from ElevenLabs, which costs money, or Kokoro, which is free and runs on this
// computer, as the recipe's `voice.provider` says. The voice pass also lays a click under each
// press and a typing sound under typing, from the timeline's `presses` and `keys`, unless
// `voice.sounds` is false; drafts have no sound at all.
//
// It writes, beside the output video: `<name>.srt`, `<name>.timeline.json` (the timeline moved
// past the freezes), `<name>.voice.json` (each line, and any still without a recording), and
// `<name>.<language>.srt` for each translation in `voice.translations`.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import type { Timeline, UnvoicedLine } from "../shared/types.ts";
import { PROJECT_FILE } from "../server/store.ts";
import { elevenLabsKey, speak } from "./elevenlabs.ts";
import { findRecipe } from "./recipe.ts";
import { duration, ffmpeg } from "./ffmpeg.ts";
import {
  alignmentFromWords,
  kokoroCommand,
  kokoroModel,
  kokoroSeed,
  kokoroSpoken,
  kokoroVoice,
  speakKokoro,
  type KokoroSettings,
} from "./kokoro.ts";
import { markingFilters } from "./markings.ts";
import { hasSounds, placeSounds, renderSounds } from "./sounds.ts";
import { writeTranslatedSubtitles } from "./translatedSubtitles.ts";
import { findRecording, readCache, saveRecording, type Recording } from "./voiceCache.ts";
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

export type VoiceProvider = "elevenlabs" | "kokoro";

/** The `voice` entry of a project's video-project.json. The Kokoro fields (`langCode`, `speed`,
 * `python`, `markup`) are described in kokoro.ts. */
export interface VoiceSettings extends KokoroSettings {
  /** Defaults to "elevenlabs". */
  provider?: VoiceProvider;
  /** The ElevenLabs voice's id, or the Kokoro voice, such as "af_heart". */
  voiceId?: string;
  /** The ElevenLabs model. Kokoro has one model. */
  model?: string;
  /** The cache folder, relative to the project folder. */
  cache?: string;
  /** How long a word takes to say in this voice; sizes the gaps left for unvoiced lines. */
  secondsPerWord?: number;
  pricePer1000Characters?: number;
  currency?: string;
  /** The narration's language, as an ISO 639-2 code such as "eng", for the subtitle track. */
  language?: string;
  /** False for a voice pass without click and typing sounds. */
  sounds?: boolean;
  /** Subtitles in other languages: each language code, such as "spa", and its file of
   * [narration phrase, translation] pairs, relative to the project (see translatedSubtitles.ts).
   * Each is written beside the video as `<name>.<code>.srt`. */
  translations?: Record<string, string>;
}

export type VoiceMode = "silent" | "pass" | "plan";

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
  /** Lines with no recording in a voiced video. Empty for a silent draft, which has none by
   * design. */
  unvoiced: UnvoicedLine[];
  silent: boolean;
  /** The video's length. */
  seconds?: number;
}

/** What a voice pass would record, and what it would cost. */
export interface VoicePlan {
  provider: VoiceProvider;
  lines: { key: string; text: string; recorded: boolean }[];
  toRecord: number;
  characters: number;
  /** 0 for Kokoro. Null when the recipe gives no price. */
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
  const provider = voiceProvider(settings);
  // A silent draft uses no recordings, even ones already made.
  const found = lines.map((l) =>
    opts.mode === "silent" ? undefined : usableRecording(cache, l.text, settings),
  );

  if (opts.mode === "plan") {
    const missing = lines.filter((_, i) => !found[i]);
    const characters = missing.reduce((n, l) => n + l.text.length, 0);
    const price = settings.pricePer1000Characters;
    return {
      provider,
      lines: lines.map((l, i) => ({ key: l.key, text: l.text, recorded: Boolean(found[i]) })),
      toRecord: missing.length,
      characters,
      cost:
        provider === "kokoro"
          ? 0
          : typeof price === "number"
            ? Math.round((characters / 1000) * price * 100) / 100
            : null,
      currency: provider === "kokoro" ? null : (settings.currency ?? null),
    };
  }

  if (opts.mode === "pass" && provider === "kokoro") {
    const missing = lines.flatMap((line, i) => (found[i] ? [] : [{ line, i }]));
    if (missing.length) {
      const recorded = await recordWithKokoro(
        missing.map((m) => m.line.text),
        settings,
        cacheDir,
        (text) => log(`recorded: ${text}`),
      );
      recorded.forEach((rec, k) => {
        cache.push(rec);
        found[missing[k].i] = rec;
      });
    }
  }

  const voiced: VoicedLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let rec = found[i];
    if (!rec && opts.mode === "pass" && provider === "elevenlabs") {
      const apiKey = elevenLabsKey();
      if (!apiKey) throw new Error("No ElevenLabs key: set one in HowReel's settings");
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
  const placement =
    opts.mode === "pass" && settings.sounds !== false ? placeSounds(timeline, plan.shift) : null;
  const soundsPath = join(o.dir, `${o.name}.sounds.wav`);
  try {
    if (placement && hasSounds(placement)) renderSounds(placement, plan.seconds, soundsPath);
    render(
      picture,
      out,
      srtPath,
      plan,
      settings.language,
      timeline,
      existsSync(soundsPath) ? soundsPath : undefined,
    );
  } finally {
    rmSync(soundsPath, { force: true });
  }

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
    unvoiced: opts.mode === "silent" ? [] : unvoicedLines(plan.lines),
    silent: opts.mode === "silent",
    seconds: plan.seconds,
  };
  writeFileSync(outTimeline, JSON.stringify(shiftTimeline(timeline, plan.shift), null, 1));
  // The translations go before the report, which HowReel takes as the sign that the video is done.
  const translated = Object.entries(settings.translations ?? {}).flatMap(([code, file]) => {
    const srtOut = join(o.dir, `${o.name}.${code}.srt`);
    try {
      const cues = writeTranslatedSubtitles({
        report,
        pairs: resolve(projectDir, file),
        out: srtOut,
      });
      return [`${code} subtitles: ${cues.length} phrases`];
    } catch (err) {
      rmSync(srtOut, { force: true });
      log(`No ${code} subtitles: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  });
  writeFileSync(join(o.dir, `${o.name}.voice.json`), JSON.stringify(report, null, 1));
  log(
    `${out} (${plan.seconds.toFixed(2)} s): ${lines.length} lines` +
      (report.silent ? " as subtitles, silent" : `, ${report.unvoiced.length} unvoiced`) +
      `, ${plan.holds.length} freezes` +
      (placement && hasSounds(placement)
        ? `, ${placement.clicks.length} clicks, ${placement.typing.length} typing runs`
        : "") +
      translated.map((t) => `, ${t}`).join(""),
  );
  return report;
}

/** The recipe's provider, checked. */
export function voiceProvider(settings: VoiceSettings): VoiceProvider {
  const provider = settings.provider ?? "elevenlabs";
  if (provider !== "elevenlabs" && provider !== "kokoro") {
    throw new Error(`voice.provider in ${PROJECT_FILE} must be "elevenlabs" or "kokoro"`);
  }
  return provider;
}

/** A recording of the line in the recipe's voice. For Kokoro, only one made from the same
 * markup, so a change to the markup records the line again. */
export function usableRecording(
  cache: Recording[],
  text: string,
  settings: VoiceSettings,
): Recording | undefined {
  const provider = voiceProvider(settings);
  if (provider === "elevenlabs") {
    return findRecording(cache, text, settings.voiceId, settings.model, provider);
  }
  const rec = findRecording(cache, text, kokoroVoice(settings), kokoroModel(settings), provider);
  const spoken = kokoroSpoken(text, settings.markup);
  return rec && (rec.spoken ?? rec.text) === spoken ? rec : undefined;
}

/** Records lines with Kokoro, all in one run, into the cache. Free. */
async function recordWithKokoro(
  texts: string[],
  settings: VoiceSettings,
  cacheDir: string,
  onRecorded: (text: string) => void,
): Promise<Recording[]> {
  const work = mkdtempSync(join(tmpdir(), "howreel-kokoro-"));
  const recorded: Recording[] = [];
  try {
    const spoken = texts.map((t) => kokoroSpoken(t, settings.markup));
    await speakKokoro({
      command: kokoroCommand(settings),
      settings,
      lines: texts.map((t, k) => ({
        spoken: spoken[k],
        seed: kokoroSeed(t),
        out: join(work, `${k}.wav`),
      })),
      onLine: (result, k) => {
        const mp3 = join(work, `${k}.mp3`);
        ffmpeg(["-i", result.out, "-c:a", "libmp3lame", "-q:a", "2", mp3]);
        recorded.push(
          saveRecording(
            cacheDir,
            {
              provider: "kokoro",
              voice: kokoroVoice(settings),
              model: kokoroModel(settings),
              text: texts[k],
              previous: "",
              next: "",
              alignment: alignmentFromWords(texts[k], result.words, result.seconds),
              spoken: spoken[k],
            },
            readFileSync(mp3),
          ),
        );
        onRecorded(texts[k]);
      },
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return recorded;
}

/** Cuts the picture at each freeze and holds its frame, mixes in the recordings, and adds the
 * subtitles as a track. */
function render(
  picture: string,
  out: string,
  srtPath: string,
  plan: ReturnType<typeof schedule>,
  language: string | undefined,
  timeline: Timeline,
  /** The click and typing sounds, as one track the length of the video. */
  sounds?: string,
): void {
  const { holds, lines, seconds } = plan;
  const pictureSeconds = seconds - holds.reduce((n, h) => n + h.length, 0);
  const cuts = [0, ...holds.map((h) => h.at), pictureSeconds];
  const parts = cuts.length - 1;
  const recorded = lines.filter((l) => l.audio);
  const audioFiles = [...recorded.map((l) => l.audio!), ...(sounds ? [sounds] : [])];
  const subtitleInput = audioFiles.length + 1;

  // Boxes go on in the picture's own time, before the freezes, so a freeze holds them as they
  // were at that frame.
  const o = parse(out);
  const marked = markingFilters({
    markings: timeline.markings ?? [],
    style: timeline.markingStyle,
    dir: o.dir,
    name: o.name,
    input: "[0:v]",
    output: "[marked]",
    firstInput: subtitleInput + 1,
    picture,
  });
  const filters: string[] = [...marked.filters];
  const picture0 = marked.filters.length ? "[marked]" : "[0:v]";
  filters.push(
    `${picture0}split=${parts}${Array.from({ length: parts }, (_, k) => `[p${k}]`).join("")}`,
  );
  for (let k = 0; k < parts; k++) {
    const pad = k < holds.length ? `,tpad=stop_mode=clone:stop_duration=${holds[k].length}` : "";
    filters.push(
      `[p${k}]trim=start=${cuts[k]}:end=${cuts[k + 1]},setpts=PTS-STARTPTS${pad}[v${k}]`,
    );
  }
  filters.push(
    `${Array.from({ length: parts }, (_, k) => `[v${k}]`).join("")}concat=n=${parts}:v=1:a=0[v]`,
  );

  recorded.forEach((l, k) =>
    filters.push(`[${k + 1}:a]adelay=${Math.round(l.at * 1000)}:all=1[a${k}]`),
  );
  const mix = [
    ...recorded.map((_, k) => `[a${k}]`),
    ...(sounds ? [`[${recorded.length + 1}:a]`] : []),
  ];
  if (mix.length) {
    filters.push(
      `${mix.join("")}amix=inputs=${mix.length}:normalize=0:duration=longest,` +
        `apad=whole_dur=${seconds.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]`,
    );
  } else {
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${seconds.toFixed(3)}[a]`);
  }

  try {
    ffmpeg([
      "-i",
      picture,
      ...audioFiles.flatMap((f) => ["-i", f]),
      "-i",
      srtPath,
      ...marked.inputs,
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
  } finally {
    (timeline.markings ?? []).forEach((_, k) =>
      rmSync(join(o.dir, `${o.name}.marking-${k}.png`), { force: true }),
    );
  }
}
