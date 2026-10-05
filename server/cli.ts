// howreel serve [<folder>] | howreel wait | howreel reply … | howreel subtitles … | howreel voice … |
// howreel image …
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse as parsePath, resolve } from "node:path";
import { defaultConfigFile } from "./config.ts";
import type { SentAnnotation, Timeline } from "../shared/types.ts";
import { image } from "../toolkit/image.ts";
import { credits, openRouterKey } from "../toolkit/openrouter.ts";
import { checkWords, readTimeline, reviewSheets, runChecks } from "../toolkit/checks.ts";
import { elevenLabsKey } from "../toolkit/elevenlabs.ts";
import {
  anchorTimes,
  audioLevels,
  contactSheet,
  parseCrop,
  screenChanges,
  summarize,
} from "../toolkit/measure.ts";
import { assemble, frameSizes, framesToVideo, gaps, oddFrames } from "../toolkit/take.ts";
import { writeTranslatedSubtitles } from "../toolkit/translatedSubtitles.ts";
import { voice, type VoiceMode } from "../toolkit/voice.ts";
import { moveOldSettings } from "./migrate.ts";
import { serve } from "./serve.ts";

const DEFAULT_PORT = 4517;

const USAGE = `Usage:
  howreel serve [<folder>] [--port N] [--user NAME] [--config FILE]
      Serve the review app for the videos under <folder>. Without <folder>, reopens the
      folder used last time. The app can switch folders too. Settings, sessions and the
      remembered folder are kept beside --config (default ~/.howreel/config.json).
  howreel wait [--port N] [--timeout SECONDS]
      Block until the reviewer clicks Send, then print the sent annotations as JSON.
  howreel reply <video> <id> <text> [--port N]
      Post Claude's reply to one annotation. Use "-" as <text> to read it from stdin.
  howreel show <video> [--port N]
      Select <video> in the open app, so the reviewer sees it.
  howreel frames <take folder>
      Make <take folder>/screen.mp4, a steady 30 fps video, from the frames the recorder
      (toolkit/recorder.ts) captured into it. Not needed after toolkit/screenRecorder.ts,
      which writes screen.mp4 itself.
  howreel assemble <take folder> <out> --title PNG [--title-text PNG] --end PNG [--trim-idle]
      Make the silent picture: the take's screen.mp4 between a title card and an end card,
      the size of its frames. --title-text, with transparency, fades in over the title.
      Writes <out name>.timeline.json beside it: the take's narration lines, actions,
      highlight boxes, arrows, fades, pointer, clicks and keys at their times in the
      picture. Applies "markingEdits" from video-project.json, keeps every box up at least
      2 s, and with --trim-idle shortens still stretches where nothing happens to 1 s.
  howreel odd-frames <take folder>
      List the take's frames whose file size is far from their neighbours', with their
      take times: the frames to look at after a take. Most are real changes in the app
      (a page reloading, a dialog); a broken capture shows the same way.
  howreel gaps <file.srt>
      Print the ten longest silences between subtitles.
  howreel sheet <video> <out.png> <time or anchor>... [--crop W:H:X:Y] [--columns N]
               [--width PX] [--timeline FILE]
      Write one PNG of the video's frames at the given moments, each labelled with its
      time. A moment is seconds, or an anchor or box key from the timeline (default
      <video name>.timeline.json), or the start of one, with an optional offset, such as
      "click: Add Page+0.3". --crop cuts each frame to that part of the picture first.
  howreel changes <video> <start> <seconds> [--threshold N] [--crop W:H:X:Y]
      Print each moment the picture changes by more than N (default 0.6; a dialog or page
      change is over 2.5, the pointer moving well under 1), with how much.
  howreel levels <video> <start> <seconds> [--step SECONDS]
      Print how loud the sound is every 0.03 s (or --step), in dB, to find when a sound
      really starts.
  howreel summarize <video or timeline.json>
      Print what the timeline holds: narration lines, actions, boxes, clicks and keys,
      with their times.
  howreel check <video> [--say-during TEXT] [--sheets FOLDER]
      Check a finished draft or voiced video against its timeline and voice report:
      narration over an action or no beat before one, boxes shown under 2 s or that
      don't leave together, clicks the screen reacts to in under 0.3 s (measured in the
      video), pointer jumps and stops mid-move. Prints each finding with its time, and
      what couldn't be checked. --say-during names a line (its words) that may play over
      an action. With --sheets, also writes a sheet per highlight box into FOLDER.
  howreel words <video> [--same SCRIPT=HEARD,...] [--language CODE]
      Costs money: transcribe a voiced video with ElevenLabs (key from HowReel's settings)
      and check that every narration word is heard once, in order, inside its own line.
      --same accepts pairs speech recognition hears another way.
  howreel subtitles <picture> <out> [--timeline FILE]
      Make the draft video: the silent picture with its narration as subtitles, each
      line shown for as long as it should take to say, from the narration lines in the
      picture's timeline (default <picture name>.timeline.json). No audio.
  howreel voice <picture> <out> --mode plan|pass [--timeline FILE]
      The voice pass, which costs money: plan prints what it would record and cost, as
      JSON, and makes nothing; pass records each narration line, keeping any recording
      already made of the same words, and lays them over the picture, with a click under
      each press and a typing sound under each run of typing. Settings come from "voice"
      in video-project.json: "provider" is "elevenlabs" (costs money) or "kokoro" (free,
      runs here).
  howreel translated-subtitles <video> <pairs.json> <code>
      Write <video name>.<code>.srt: subtitles in another language for a reviewer, in
      short phrases, each starting when the narration reaches the phrase's first word.
      <pairs.json> is a list of [narration phrase, translation] pairs that together make
      up the narration; timings come from <video name>.voice.json. "voice" and
      "subtitles" write these themselves for each language in "translations" in the
      recipe's voice entry.
  howreel image <out> [<input>...] --prompt TEXT [--references] [--aspect 16:9 | --size WxH]
               [--quality Q] [--model ID] [--estimate]
      Make an image from TEXT through OpenRouter (key from HowReel's settings). Given
      <input> images, edit the first, with any others as references; with --references,
      make a new image from them all. --aspect is one of 2:3 3:4 9:16 1:1 4:3 3:2 16:9
      21:9; --size asks for exact pixels, brought to the nearest the model accepts;
      without either, an edit keeps its image's shape. Use "-" as TEXT to read it from
      stdin. The model defaults to "images.model" in video-project.json, else
      openai/gpt-image-2.5-sunburst. Prints the file and what it cost; --estimate prints
      only the estimated cost and makes nothing.
  howreel image --credits
      Print what's left on the OpenRouter account.

The port defaults to $HOWREEL_PORT, or ${DEFAULT_PORT}.`;

/** Options that take no value. */
const SWITCHES = new Set(["estimate", "references", "credits", "trim-idle"]);

function parse(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (SWITCHES.has(arg.slice(2))) {
      flags[arg.slice(2)] = "yes";
    } else if (arg.startsWith("--")) {
      flags[arg.slice(2)] = argv[++i] ?? "";
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function main() {
  moveOldSettings();
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parse(rest);
  const port = Number(flags.port ?? process.env.HOWREEL_PORT ?? DEFAULT_PORT);
  const base = `http://127.0.0.1:${port}`;

  switch (command) {
    case "serve": {
      const server = await serve({
        root: positional[0],
        port,
        user: flags.user,
        ...(flags.config ? { configFile: flags.config } : {}),
        agentClaudeDir: join(dirname(flags.config ?? defaultConfigFile()), "claude"),
      });
      const where = server.root ?? "no folder yet (choose one in the app)";
      console.log(`HowReel is serving ${where} at http://localhost:${server.port}`);
      break;
    }

    case "wait": {
      // Each request is answered after at most `hold` seconds, empty if nothing was sent,
      // so keep asking until something arrives or --timeout runs out.
      const deadline = flags.timeout ? Date.now() + Number(flags.timeout) * 1000 : Infinity;
      let failures = 0;
      for (;;) {
        const left = Math.ceil((deadline - Date.now()) / 1000);
        if (left <= 0) {
          console.log("[]");
          return;
        }
        let sent: SentAnnotation[];
        try {
          const res = await fetch(`${base}/api/wait?hold=${Math.min(50, left)}`);
          sent = (await res.json()) as SentAnnotation[];
          failures = 0;
        } catch (err) {
          // Ride out a server restart, but not a server that is gone.
          if (++failures > 5) {
            throw new Error(
              `Could not reach the HowReel server at ${base}. Is \`howreel serve\` running?`,
              { cause: err },
            );
          }
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        if (sent.length) {
          console.log(JSON.stringify(sent, null, 2));
          return;
        }
      }
    }

    case "reply": {
      const [video, id, ...words] = positional;
      let text = words.join(" ");
      if (text === "-") text = readFileSync(0, "utf8");
      if (!video || !id || !text.trim()) throw new UsageError("reply needs <video> <id> <text>");
      const res = await fetch(`${base}/api/claude-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video, id: Number(id), text }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
      console.log(`Replied to annotation ${id} on ${video}`);
      break;
    }

    case "show": {
      const [video] = positional;
      if (!video) throw new UsageError("show needs <video>");
      const res = await fetch(`${base}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video: resolve(video) }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
      console.log(`Showing ${((await res.json()) as { video: string }).video}`);
      break;
    }

    case "subtitles": {
      const [picture, out] = positional;
      if (!picture || !out) throw new UsageError("subtitles needs <picture> <out>");
      await voice({ picture, out, timeline: flags.timeline, mode: "silent" });
      break;
    }

    case "voice": {
      const [picture, out] = positional;
      const mode = flags.mode as VoiceMode;
      if (mode !== "pass" && mode !== "plan")
        throw new UsageError("voice needs --mode plan or pass");
      if (!picture || (!out && mode !== "plan")) {
        throw new UsageError("voice needs <picture> <out>");
      }
      const result = await voice({ picture, out: out ?? "", timeline: flags.timeline, mode });
      if (mode === "plan") console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "frames": {
      const [take] = positional;
      if (!take) throw new UsageError("frames needs <take folder>");
      console.log(framesToVideo(resolve(take)));
      break;
    }

    case "assemble": {
      const [take, out] = positional;
      if (!take || !out || !flags.title || !flags.end) {
        throw new UsageError("assemble needs <take folder> <out> --title PNG --end PNG");
      }
      const made = assemble({
        takeDir: resolve(take),
        out: resolve(out),
        cards: {
          title: resolve(flags.title),
          titleText: flags["title-text"] ? resolve(flags["title-text"]) : undefined,
          end: resolve(flags.end),
        },
        trimIdle: flags["trim-idle"] ? true : undefined,
      });
      console.log(`${resolve(out)} (${made.seconds.toFixed(2)} s)`);
      if (made.trimmed) console.log(`${made.trimmed.toFixed(2)} s of still picture cut`);
      console.log(made.timeline);
      break;
    }

    case "odd-frames": {
      const [take] = positional;
      if (!take) throw new UsageError("odd-frames needs <take folder>");
      const odd = oddFrames(frameSizes(resolve(take)));
      for (const f of odd) {
        console.log(`${f.t.toFixed(2)}  ${f.file}  ${f.size} bytes (around ${f.usual})`);
      }
      console.log(`${odd.length} frames to look at`);
      break;
    }

    case "gaps": {
      const [srtFile] = positional;
      if (!srtFile) throw new UsageError("gaps needs <file.srt>");
      for (const g of gaps(readFileSync(srtFile, "utf8"))) {
        console.log(`${g.gap.toFixed(1)} s before ${g.at.toFixed(1)}: ${g.text}`);
      }
      break;
    }

    case "sheet": {
      const [video, out, ...moments] = positional;
      if (!video || !out || !moments.length) {
        throw new UsageError("sheet needs <video> <out.png> and at least one moment");
      }
      const timeline = flags.timeline
        ? (JSON.parse(readFileSync(flags.timeline, "utf8")) as Timeline)
        : existsSync(timelineBeside(video))
          ? readTimeline(video)
          : { anchors: [] };
      const at = anchorTimes(timeline, moments);
      console.log(
        contactSheet({
          video: resolve(video),
          out: resolve(out),
          times: at.map((m) => m.t),
          labels: at.map((m) => m.label),
          crop: flags.crop ? parseCrop(flags.crop) : undefined,
          columns: flags.columns ? Number(flags.columns) : undefined,
          width: flags.width ? Number(flags.width) : undefined,
        }),
      );
      break;
    }

    case "changes": {
      const [video, start, seconds] = positional;
      if (!video || !start || !seconds)
        throw new UsageError("changes needs <video> <start> <seconds>");
      const changes = screenChanges(resolve(video), Number(start), Number(seconds), {
        threshold: flags.threshold ? Number(flags.threshold) : undefined,
        crop: flags.crop ? parseCrop(flags.crop) : undefined,
      });
      for (const c of changes) console.log(`${c.t.toFixed(3)}  ${c.diff.toFixed(2)}`);
      break;
    }

    case "levels": {
      const [video, start, seconds] = positional;
      if (!video || !start || !seconds)
        throw new UsageError("levels needs <video> <start> <seconds>");
      const levels = audioLevels(
        resolve(video),
        Number(start),
        Number(seconds),
        flags.step ? Number(flags.step) : undefined,
      );
      for (const l of levels) console.log(`${l.t.toFixed(3)}  ${l.db.toFixed(1)}`);
      break;
    }

    case "summarize": {
      const [file] = positional;
      if (!file) throw new UsageError("summarize needs <video or timeline.json>");
      const timeline = file.endsWith(".json")
        ? (JSON.parse(readFileSync(file, "utf8")) as Timeline)
        : readTimeline(resolve(file));
      console.log(summarize(timeline));
      break;
    }

    case "check": {
      const [video] = positional;
      if (!video) throw new UsageError("check needs <video>");
      const { findings, skipped } = runChecks({
        video: resolve(video),
        sayDuring: flags["say-during"] ? [flags["say-during"]] : undefined,
      });
      for (const f of findings) console.log(`${f.t.toFixed(2)}  ${f.check}: ${f.message}`);
      for (const s of skipped) console.log(`not checked: ${s}`);
      if (flags.sheets) {
        reviewSheets(resolve(video), readTimeline(resolve(video)), resolve(flags.sheets), (line) =>
          console.log(line),
        );
      }
      if (findings.length) process.exitCode = 1;
      break;
    }

    case "words": {
      const [video] = positional;
      if (!video) throw new UsageError("words needs <video>");
      const apiKey = elevenLabsKey();
      if (!apiKey) throw new Error("No ElevenLabs key: set one in HowReel's settings");
      const sameWords = (flags.same ?? "")
        .split(",")
        .filter((pair) => pair.includes("="))
        .map((pair) => pair.split("=") as [string, string]);
      const findings = await checkWords({
        video: resolve(video),
        apiKey,
        sameWords,
        language: flags.language,
      });
      for (const f of findings) console.log(`${f.t.toFixed(2)}  ${f.check}: ${f.message}`);
      if (findings.length) process.exitCode = 1;
      else console.log("Every word heard once, in order, in its own line.");
      break;
    }

    case "translated-subtitles": {
      const [video, pairs, code] = positional;
      if (!video || !pairs || !code) {
        throw new UsageError("translated-subtitles needs <video> <pairs.json> <code>");
      }
      const v = parsePath(resolve(video));
      const out = join(v.dir, `${v.name}.${code}.srt`);
      const cues = writeTranslatedSubtitles({
        report: join(v.dir, `${v.name}.voice.json`),
        pairs: resolve(pairs),
        out,
      });
      console.log(`${out} (${cues.length} cues)`);
      break;
    }

    case "image": {
      if (flags.credits) {
        const key = openRouterKey();
        if (!key) throw new Error("No OpenRouter key: set one in HowReel's settings");
        const c = await credits(key);
        console.log(`$${c.remaining.toFixed(2)} left of $${c.total.toFixed(2)}`);
        break;
      }
      const [out, ...inputs] = positional;
      let prompt = flags.prompt ?? "";
      if (prompt === "-") prompt = readFileSync(0, "utf8");
      if (!out || !prompt.trim()) throw new UsageError("image needs <out> and --prompt");
      const made = await image({
        out,
        prompt,
        inputs,
        fromReferences: Boolean(flags.references),
        aspect: flags.aspect,
        size: flags.size,
        quality: flags.quality,
        model: flags.model,
        estimate: Boolean(flags.estimate),
      });
      const estimate =
        made.estimatedCost === null
          ? "no estimate for this model"
          : `about $${made.estimatedCost.toFixed(3)}`;
      if (!made.out) {
        console.log(`${made.model}${made.size ? ` at ${made.size}` : ""}: ${estimate}`);
      } else {
        const cost = made.cost === null ? estimate : `$${made.cost.toFixed(4)}`;
        console.log(`${made.out} (${made.model}${made.size ? ` at ${made.size}` : ""}, ${cost})`);
      }
      break;
    }

    default:
      throw new UsageError(command ? `Unknown command: ${command}` : "No command given");
  }
}

class UsageError extends Error {}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  if (err instanceof UsageError) console.error("\n" + USAGE);
  process.exit(1);
});

/** Where a video's timeline is kept: `<video name>.timeline.json` beside it. */
function timelineBeside(video: string): string {
  return resolve(video).replace(/\.[^.\\/]+$/, "") + ".timeline.json";
}
