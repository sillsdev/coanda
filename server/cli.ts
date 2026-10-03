// coanda serve <folder> | coanda wait | coanda reply <video> <id> <text>
import { readFileSync } from "node:fs";
import type { SentAnnotation } from "../shared/types.ts";
import { serve } from "./serve.ts";

const DEFAULT_PORT = 4517;

const USAGE = `Usage:
  coanda serve <folder> [--port N] [--user NAME]
      Serve the review app for the videos under <folder>.
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
      const root = positional[0];
      if (!root) throw new UsageError("serve needs a folder");
      const server = await serve({ root, port, user: flags.user });
      console.log(`Coanda is serving ${root} at http://localhost:${server.port}`);
      break;
    }

    case "wait": {
      const timeout = flags.timeout ? Number(flags.timeout) * 1000 : undefined;
      const signal = timeout ? AbortSignal.timeout(timeout) : undefined;
      let sent: SentAnnotation[];
      try {
        const res = await fetch(`${base}/api/wait`, { signal });
        sent = (await res.json()) as SentAnnotation[];
      } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") {
          console.log("[]");
          return;
        }
        throw new Error(
          `Could not reach the Coanda server at ${base}. Is \`coanda serve\` running?`,
          { cause: err },
        );
      }
      console.log(JSON.stringify(sent, null, 2));
      break;
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
