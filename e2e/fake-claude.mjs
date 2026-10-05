// A stand-in for the `claude` CLI, for the end-to-end tests. It speaks the stream-json
// protocol Howbench uses and keeps a turn count per session in $FAKE_CLAUDE_STATE, so a test can
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

const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "claude-opus-5-5";
out({ type: "system", subtype: "init", session_id: sessionId, permissionMode: "auto", model });
// Resuming a conversation whose last turn was cut off, Claude Code first ends that turn, with a
// result of its own, before it reads anything new. Do that on every resume.
if (resume) {
  say([{ type: "text", text: "No response requested." }]);
  out({ type: "result", subtype: "success", is_error: false, result: "", session_id: sessionId });
}

// Turns run one at a time, in order.
let queue = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const text = JSON.parse(line).message.content;
  queue = queue.then(() => turn(text));
});

// FAKE_CLAUDE_HIGH=1 reports a nearly full context and nearly used-up limits.
const high = process.env.FAKE_CLAUDE_HIGH === "1";

async function turn(text) {
  state.lastMessage = text;
  if (text === "/compact") {
    // As Claude Code reports a compaction: status, the boundary with token counts, the
    // command's own output echoed as a user message, then an empty result.
    out({ type: "system", subtype: "status", status: "compacting" });
    await sleep(300);
    out({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: high ? 620000 : 40010, post_tokens: 7487 },
    });
    out({
      type: "user",
      message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" },
    });
    out({ type: "result", subtype: "success", is_error: false, result: "", session_id: sessionId });
    return;
  }
  // As Claude Code does with --replay-user-messages: echo the message as the turn starts.
  if (args.includes("--replay-user-messages")) {
    out({ type: "user", isReplay: true, message: { role: "user", content: text } });
  }
  state.turns += 1;
  save();
  const now = Math.floor(Date.now() / 1000);
  out({
    type: "rate_limit_event",
    rate_limit_info: {
      unifiedWindows: {
        five_hour: { utilization: high ? 0.85 : 0.15, resetsAt: now + 2 * 3600 + 10 * 60 },
        seven_day: { utilization: high ? 0.82 : 0.16, resetsAt: now + 3 * 86400 + 4 * 3600 + 30 },
      },
    },
  });
  out({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `Turn ${state.turns} in session ${sessionId}` }],
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: high ? 620000 : 40000,
        cache_creation_input_tokens: 0,
        output_tokens: 8,
      },
    },
  });
  say([
    { type: "tool_use", id: randomUUID(), name: "Bash", input: { command: "node render.mjs" } },
  ]);
  await sleep(700);

  let replies = [];
  const unvoiced = {};
  const timeMap = {};
  const marker = "Annotations from the reviewer:";
  // A send may follow a "[Howbench] instructions have changed" preface.
  if (text.includes(marker)) {
    const send = JSON.parse(text.slice(text.indexOf(marker) + marker.length));
    // A note asking to insert words gets a line with no recording, as a real build would.
    const inserts = (a) => /\binsert\b/i.test(a.text);
    replies = send.videos.flatMap((v) =>
      v.annotations.map((a) => ({
        video: v.video,
        id: a.id,
        text: `Fixed: ${a.text}`,
        status: inserts(a) ? "voice" : "done",
      })),
    );
    // A comment on a document that asks something gets a question back.
    for (const d of send.documents ?? []) {
      for (const c of d.comments) {
        replies.push({
          video: d.document,
          id: c.id,
          text: /\?/.test(c.text) ? `Which do you mean: "${c.quote.exact}"?` : `Fixed: ${c.text}`,
          status: /\?/.test(c.text) ? "question" : "done",
        });
      }
    }
    for (const v of send.videos) {
      // A note asking to remove something cuts two seconds around it, as a real re-cut would.
      const removal = v.annotations.find((a) => /\bremove\b/i.test(a.text));
      if (removal) {
        const t = removal.t;
        timeMap[v.video] = [
          { from: [0, t - 1], to: [0, t - 1] },
          { from: [t + 1, 100000], to: [t - 1, 99998] },
        ];
      }
      unvoiced[v.video] = v.annotations
        .filter(inserts)
        .map((a) => ({ start: a.t, end: a.t + 2, text: a.text }));
    }
  }
  // A voice pass records every missing line.
  const pass = /^\[Howbench\] Voice pass for (.+?)\. /.exec(text);
  if (pass) unvoiced[pass[1]] = [];
  // Asked to ask, it asks two questions, as cards for the reviewer to answer.
  const questions = /ask me/i.test(text)
    ? [
        { text: "Should every page get a picture?", options: ["Yes", "No"] },
        { text: "Which language should the book be in?", options: [] },
      ]
    : [];
  const status = text.includes("?") ? "question" : "done";
  const block = JSON.stringify({ status, replies, unvoiced, timeMap, questions });
  say([{ type: "text", text: "Rendered.\n\n```howbench\n" + block + "\n```" }]);
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    modelUsage: { [model]: { contextWindow: 1000000 } },
  });
}
