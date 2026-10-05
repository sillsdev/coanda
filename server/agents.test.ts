import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { AgentManager, type AgentOptions, type CoandaReply } from "./agents.ts";

// A stand-in for Claude Code. Each message is a turn, taken one at a time: it echoes the
// message, says "Got: <message>", writes a coanda block replying to note <turn number>, waits 400 ms, then gives the
// turn's result.
const FAKE = `
import { createInterface } from "node:readline";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
out({ type: "system", subtype: "init", session_id: "s1", model: "m" });
let turns = 0;
let queue = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  const text = JSON.parse(line).message.content;
  queue = queue.then(async () => {
    out({ type: "user", isReplay: true, message: { role: "user", content: text } });
    out({ type: "assistant", message: { content: [{ type: "text", text: "Got: " + text }] } });
    const id = ++turns;
    const block = JSON.stringify({ status: "done", replies: [{ video: "a.mp4", id, text: "Fixed " + id }] });
    out({ type: "assistant", message: { content: [{ type: "text", text: "Done.\\n\\n\`\`\`coanda\\n" + block + "\\n\`\`\`" }] } });
    await sleep(400);
    out({ type: "result", is_error: false });
  });
});
`;

let dir: string;
let replies: { video: string; id: number; reply: CoandaReply }[];
let manager: AgentManager | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "coanda-agents-"));
  writeFileSync(join(dir, "fake.mjs"), FAKE);
  replies = [];
});

afterEach(() => {
  manager?.stopAll();
  manager = undefined;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function make(over: Partial<AgentOptions> = {}): AgentManager {
  manager = new AgentManager({
    cwd: dir,
    command: [process.execPath, join(dir, "fake.mjs")],
    sessionsFile: join(dir, "sessions.json"),
    onChange: () => {},
    onReply: (video, id, reply) => replies.push({ video, id, reply }),
    onTimeMap: () => {},
    onRenderedWithoutMap: () => {},
    onUnvoiced: () => {},
    onQuestions: () => {},
    ...over,
  });
  return manager;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(20);
  }
}

test("a message sent while a turn is under way keeps that turn's replies", async () => {
  const agents = make();
  agents.send("p", "first");
  await until(() => agents.state("p").messages.some((m) => m.text === "Done."));
  agents.send("p", "second");
  await until(() => replies.length === 1);
  expect(agents.status("p")).toBe("working");
  await until(() => replies.length === 2);
  expect(replies.map((r) => r.id)).toEqual([1, 2]);
  expect(agents.status("p")).toBe("done");
});

test("output that arrives from a process after stopAll is ignored", async () => {
  const agents = make();
  agents.send("p", "first");
  await until(() => agents.state("p").sessionId === "s1");
  const proc = (
    agents as unknown as {
      sessions: Map<string, { proc?: NodeJS.EventEmitter & { stdout: NodeJS.EventEmitter } }>;
    }
  ).sessions.get("p")!.proc!;
  agents.stopAll();
  const block = JSON.stringify({ replies: [{ video: "a.mp4", id: 1, text: "Late" }] });
  const lines = [
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "```coanda\n" + block + "\n```" }] },
    },
    { type: "result", is_error: false },
  ];
  proc.stdout.emit("data", Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n") + "\n"));
  expect(replies).toEqual([]);
});

test("stopAll saves the transcript at once and leaves the sessions file alone afterwards", async () => {
  const file = join(dir, "sessions.json");
  const agents = make();
  agents.send("p", "first");
  await until(() => agents.state("p").messages.some((m) => m.text === "Done."));
  agents.stopAll();
  const saved = JSON.parse(readFileSync(file, "utf8"))[dir.toLowerCase()].p;
  expect(saved.working).toBe(true);
  expect(saved.messages.map((m: { text: string }) => m.text)).toEqual([
    "first",
    "Got: first",
    "Done.",
  ]);
  // What the next manager writes stays, past the 1 s the old one waited to save.
  writeFileSync(file, '{"next":true}');
  await sleep(1300);
  expect(readFileSync(file, "utf8")).toBe('{"next":true}');
});

test("a stopped turn is saved as stopped, so it is not carried on next time", async () => {
  const agents = make();
  agents.send("p", "first");
  await until(() => agents.state("p").messages.some((m) => m.text === "Done."));
  agents.stop("p");
  const saved = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"))[dir.toLowerCase()].p;
  expect(saved.working).toBe(false);
});

test("a turn cut off by a restart is carried on with the last message sent, shown or not", async () => {
  writeFileSync(
    join(dir, "sessions.json"),
    JSON.stringify({
      [dir.toLowerCase()]: {
        p: {
          sessionId: "s1",
          messages: [{ role: "user", text: "Older message", at: "2026-01-01T00:00:00Z" }],
          lastSent: "Answer: yes",
          working: true,
        },
      },
    }),
  );
  const agents = make();
  await until(() => agents.state("p").messages.some((m) => m.text.startsWith("Got: ")));
  const got = agents.state("p").messages.find((m) => m.text.startsWith("Got: "))!.text;
  expect(got).toContain("the reviewer's last message was:\n\nAnswer: yes");
  expect(got).not.toContain("Older message");
  await until(() => agents.status("p") === "done");
  const saved = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"))[dir.toLowerCase()].p;
  expect(saved.lastSent).toBe("Answer: yes");
});

// A stand-in for Claude Code that leaves a command running in the background, ends its turn,
// and starts a turn of its own when the command finishes, as Claude Code does.
const BACKGROUND = `
import { createInterface } from "node:readline";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
out({ type: "system", subtype: "init", session_id: "s2", model: "m" });
createInterface({ input: process.stdin }).on("line", (line) => {
  const text = JSON.parse(line).message.content;
  out({ type: "user", isReplay: true, message: { role: "user", content: text } });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Got: " + text }] } });
  if (!text.startsWith("record")) return out({ type: "result", is_error: false });
  out({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b1", description: "record take 4" }] });
  out({ type: "result", is_error: false });
  setTimeout(() => {
    out({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    out({ type: "system", subtype: "task_notification", task_id: "b1", status: "completed" });
    out({ type: "assistant", message: { content: [{ type: "text", text: "Recorded." }] } });
    setTimeout(() => out({ type: "result", is_error: false }), 300);
  }, Number(process.env.FINISH_AFTER ?? 600));
});
`;

test("a command left running in the background shows, and Claude's own turn after it is working", async () => {
  writeFileSync(join(dir, "background.mjs"), BACKGROUND);
  const agents = make({ command: [process.execPath, join(dir, "background.mjs")] });
  agents.send("p", "record it");
  await until(() => agents.status("p") === "done" && !!agents.state("p").background);
  expect(agents.state("p").background).toEqual(["record take 4"]);
  await until(() => agents.status("p") === "working");
  expect(agents.state("p").workingSince).toBeTruthy();
  await until(() => agents.status("p") === "done" && !agents.state("p").background);
  expect(agents.state("p").messages.at(-1)?.text).toBe("Recorded.");
});

test("a restart tells Claude which background commands it killed", async () => {
  writeFileSync(join(dir, "background.mjs"), BACKGROUND);
  process.env.FINISH_AFTER = "60000";
  try {
    const command = [process.execPath, join(dir, "background.mjs")];
    const first = make({ command });
    first.send("p", "record it");
    await until(() => !!first.state("p").background);
    first.stopAll();
    const second = make({ command });
    await until(() => second.state("p").messages.some((m) => m.text.includes("record take 4")));
    const told = second.state("p").messages.find((m) => m.text.startsWith("Got: [Coanda]"));
    expect(told?.text).toContain("killed the command");
    expect(told?.text).toContain("- record take 4");
    expect(
      second
        .state("p")
        .messages.some((m) => m.role === "user" && /stopped what was running/.test(m.text)),
    ).toBe(true);
  } finally {
    delete process.env.FINISH_AFTER;
  }
});
