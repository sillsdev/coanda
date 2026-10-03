// coanda serve [<folder>] | coanda wait | coanda reply <video> <id> <text> | coanda voice …
import { readFileSync } from "node:fs";
import type { SentAnnotation } from "../shared/types.ts";
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
  coanda voice <picture> <out> [--timeline FILE] [--mode reuse|pass|plan]
      Lay narration over a silent picture, from the narration lines in its timeline
      (default <picture name>.timeline.json). reuse (the default) uses recordings already
      in the voice cache and leaves a gap for any other line; pass records the missing
      lines first, which costs money; plan prints what a pass would record and cost, as
      JSON, and makes nothing. Settings come from "voice" in video-project.json.

The port defaults to $COANDA_PORT, or ${DEFAULT_PORT}.`;

function parse(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
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

    case "voice": {
      const [picture, out] = positional;
      const mode = (flags.mode ?? "reuse") as VoiceMode;
      if (!["reuse", "pass", "plan"].includes(mode)) throw new UsageError(`Unknown mode ${mode}`);
      if (!picture || (!out && mode !== "plan"))
        throw new UsageError("voice needs <picture> <out>");
      const result = await voice({ picture, out: out ?? "", timeline: flags.timeline, mode });
      if (mode === "plan") console.log(JSON.stringify(result, null, 2));
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
