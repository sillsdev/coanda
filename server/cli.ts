// coanda serve [<folder>] | coanda wait | coanda reply <video> <id> <text>
import { readFileSync } from "node:fs";
import type { SentAnnotation } from "../shared/types.ts";
import { serve } from "./serve.ts";

const DEFAULT_PORT = 4517;

const USAGE = `Usage:
  coanda serve [<folder>] [--port N] [--user NAME]
      Serve the review app for the videos under <folder>. Without <folder>, reopens the
      folder used last time. The app can switch folders too.
  coanda wait [--port N] [--timeout SECONDS]
      Block until the reviewer clicks Send, then print the sent annotations as JSON.
  coanda reply <video> <id> <text> [--port N]
      Post Claude's reply to one annotation. Use "-" as <text> to read it from stdin.

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
      const server = await serve({ root: positional[0], port, user: flags.user });
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
