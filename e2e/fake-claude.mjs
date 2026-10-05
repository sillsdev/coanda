// A stand-in for the `claude` CLI, for the end-to-end tests. It speaks the stream-json
// protocol Coanda uses and keeps a turn count per session in $FAKE_CLAUDE_STATE, so a test can
// tell a resumed conversation from a new one.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const stateDir = process.env.FAKE_CLAUDE_STATE;

if (args[0] === "auth") {
  console.log(JSON.stringify({ loggedIn: true, email: "reviewer@example.org" }));
  process.exit(0);
}

const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : undefined;
const sessionId = resume ?? `fake-${randomUUID().slice(0, 8)}`;
const stateFile = join(stateDir, `${sessionId}.json`);
const state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, "utf8"))
  : { turns: 0, starts: [] };
state.starts.push({ args, cwd: process.cwd() });
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));
save();

const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const say = (content) => out({ type: "assistant", message: { role: "assistant", content } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

out({ type: "system", subtype: "init", session_id: sessionId, permissionMode: "auto" });

// Turns run one at a time, in order.
let queue = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const text = JSON.parse(line).message.content;
  queue = queue.then(() => turn(text));
});

async function turn(text) {
  state.turns += 1;
  save();
  say([{ type: "text", text: `Turn ${state.turns} in session ${sessionId}` }]);
  say([
    { type: "tool_use", id: randomUUID(), name: "Bash", input: { command: "node render.mjs" } },
  ]);
  await sleep(700);

  let replies = [];
  const marker = "Annotations from the reviewer:";
  if (text.startsWith(marker)) {
    const sent = JSON.parse(text.slice(marker.length));
    replies = sent.map((a) => ({
      video: a.video,
      id: a.id,
      text: `Fixed: ${a.text}${a.voiceReady ? "" : " (no new voice)"}`,
    }));
  }
  const status = text.includes("?") ? "question" : "done";
  const block = JSON.stringify({ status, replies });
  say([{ type: "text", text: "Rendered.\n\n```coanda\n" + block + "\n```" }]);
  out({ type: "result", subtype: "success", is_error: false, session_id: sessionId });
}
