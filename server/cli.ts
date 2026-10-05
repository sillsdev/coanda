// coanda serve [<folder>] | coanda wait | coanda reply … | coanda subtitles … | coanda voice … |
// coanda image …
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SentAnnotation } from "../shared/types.ts";
import { image } from "../toolkit/image.ts";
import { credits, openRouterKey } from "../toolkit/openrouter.ts";
import { voice, type VoiceMode } from "../toolkit/voice.ts";
import { serve } from "./serve.ts";

const DEFAULT_PORT = 4517;

const USAGE = `Usage:
  coanda serve [<folder>] [--port N] [--user NAME] [--config FILE]
      Serve the review app for the videos under <folder>. Without <folder>, reopens the
      folder used last time. The app can switch folders too. Settings, sessions and the
      remembered folder are kept beside --config (default ~/.coanda/config.json).
  coanda wait [--port N] [--timeout SECONDS]
      Block until the reviewer clicks Send, then print the sent annotations as JSON.
  coanda reply <video> <id> <text> [--port N]
      Post Claude's reply to one annotation. Use "-" as <text> to read it from stdin.
  coanda show <video> [--port N]
      Select <video> in the open app, so the reviewer sees it.
  coanda subtitles <picture> <out> [--timeline FILE]
      Make the draft video: the silent picture with its narration as subtitles, each
      line shown for as long as it should take to say, from the narration lines in the
      picture's timeline (default <picture name>.timeline.json). No audio.
  coanda voice <picture> <out> --mode plan|pass [--timeline FILE]
      The voice pass, which costs money: plan prints what it would record and cost, as
      JSON, and makes nothing; pass records each narration line, keeping any recording
      already made of the same words, and lays them over the picture. Settings come from
      "voice" in video-project.json.
  coanda image <out> [<input>...] --prompt TEXT [--references] [--aspect 16:9 | --size WxH]
               [--quality Q] [--model ID] [--estimate]
      Make an image from TEXT through OpenRouter (key from Coanda's settings). Given
      <input> images, edit the first, with any others as references; with --references,
      make a new image from them all. --aspect is one of 2:3 3:4 9:16 1:1 4:3 3:2 16:9
      21:9; --size asks for exact pixels, brought to the nearest the model accepts;
      without either, an edit keeps its image's shape. Use "-" as TEXT to read it from
      stdin. The model defaults to "images.model" in video-project.json, else
      openai/gpt-image-2.5-sunburst. Prints the file and what it cost; --estimate prints
      only the estimated cost and makes nothing.
  coanda image --credits
      Print what's left on the OpenRouter account.

The port defaults to $COANDA_PORT, or ${DEFAULT_PORT}.`;

/** Options that take no value. */
const SWITCHES = new Set(["estimate", "references", "credits"]);

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
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parse(rest);
  const port = Number(flags.port ?? process.env.COANDA_PORT ?? DEFAULT_PORT);
  const base = `http://127.0.0.1:${port}`;

  switch (command) {
    case "serve": {
      const server = await serve({
        root: positional[0],
        port,
        user: flags.user,
        ...(flags.config ? { configFile: flags.config } : {}),
      });
      const where = server.root ?? "no folder yet (choose one in the app)";
      console.log(`Coanda is serving ${where} at http://localhost:${server.port}`);
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
              `Could not reach the Coanda server at ${base}. Is \`coanda serve\` running?`,
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

    case "image": {
      if (flags.credits) {
        const key = openRouterKey();
        if (!key) throw new Error("No OpenRouter key: set one in Coanda's settings");
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
      const estimate = `about $${made.estimatedCost.toFixed(3)}`;
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
