// One long-running Claude Code process per video project, driven over stream-json.
//
// The process is `claude -p --input-format stream-json --output-format stream-json`, which
// keeps one conversation open and takes message after message on stdin. Its session ID is
// saved, so after a restart `--resume` picks the same conversation back up.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage, AgentState, AgentStatus } from "../shared/types.ts";

export const PROTOCOL = `You are working with a reviewer through Coanda, a video review app.
The reviewer watches the videos you make, annotates them, and sends the annotations to you.

Each send is a JSON list of annotations. Each has: video (path relative to the working folder),
videoFile (absolute), id, t (seconds), kind ("pin" at x,y or "arrow" from x,y to x2,y2;
percentages of the frame), text, author, thread (earlier replies), frameFile (a PNG of the
annotated frame: read it, the position only makes sense against it), and voiceReady.

voiceReady is the video's "Ready for voice" switch. While it is false, do not generate new
voice-over audio; it costs money. Reuse the existing narration or a placeholder.

Make the changes, re-render to the same video file path, then end your turn with exactly one
fenced block like this, answering every annotation you were sent:

\`\`\`coanda
{"status": "done", "replies": [{"video": "<video>", "id": 1, "text": "What you changed."}]}
\`\`\`

Use "status": "question" instead of "done" when you need the reviewer to answer or decide
something before you can go on, and say what in your reply text or your message.
The reviewer may also message you directly; end those turns with a coanda block too
(with an empty replies list if there is nothing to answer).`;

const MAX_MESSAGES = 400;

interface Session {
  status: AgentStatus;
  sessionId?: string;
  messages: AgentMessage[];
  proc?: ChildProcessWithoutNullStreams;
  /** Text of the assistant messages in the current turn, for finding the coanda block. */
  turnText: string[];
}

export interface AgentOptions {
  /** Folder the agents work in: the reviewed folder. */
  cwd: string;
  /** How to run Claude Code; the tests substitute a stand-in. */
  command: string[];
  /** Where session IDs and transcripts are kept between runs. */
  sessionsFile: string;
  env?: Record<string, string>;
  onChange: (project: string) => void;
  onReply: (video: string, id: number, text: string) => void;
}

export class AgentManager {
  private sessions = new Map<string, Session>();
  private opts: AgentOptions;

  constructor(opts: AgentOptions) {
    this.opts = opts;
    for (const [project, saved] of Object.entries(this.loadSaved())) {
      this.sessions.set(project, {
        status: "idle",
        sessionId: saved.sessionId,
        messages: saved.messages ?? [],
        turnText: [],
      });
    }
  }

  state(project: string): AgentState {
    const s = this.sessions.get(project);
    return { status: s?.status ?? "idle", messages: s?.messages ?? [], sessionId: s?.sessionId };
  }

  status(project: string): AgentStatus {
    return this.sessions.get(project)?.status ?? "idle";
  }

  send(project: string, text: string, shown = text): void {
    const s = this.session(project);
    if (!s.proc) this.start(project, s);
    this.push(project, s, { role: "user", text: shown });
    s.status = "working";
    s.turnText = [];
    s.proc!.stdin.write(
      JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n",
    );
    this.opts.onChange(project);
  }

  stop(project: string): void {
    const s = this.sessions.get(project);
    if (!s?.proc) return;
    s.proc.kill();
    s.proc = undefined;
    s.status = "idle";
    this.opts.onChange(project);
  }

  stopAll(): void {
    for (const s of this.sessions.values()) s.proc?.kill();
  }

  private session(project: string): Session {
    let s = this.sessions.get(project);
    if (!s) {
      s = { status: "idle", messages: [], turnText: [] };
      this.sessions.set(project, s);
    }
    return s;
  }

  private start(project: string, s: Session) {
    const [cmd, ...base] = this.opts.command;
    const args = [
      ...base,
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "auto",
      "--append-system-prompt",
      PROTOCOL,
      ...(s.sessionId ? ["--resume", s.sessionId] : []),
    ];
    const proc = spawn(cmd, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      windowsHide: true,
    });
    s.proc = proc;

    let buffer = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) this.onLine(project, s, line);
      }
    });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    proc.on("error", (err) => {
      this.push(project, s, { role: "error", text: err.message });
      s.status = "error";
      s.proc = undefined;
      this.opts.onChange(project);
    });
    proc.on("exit", (code) => {
      if (s.proc !== proc) return;
      s.proc = undefined;
      if (s.status === "working") {
        this.push(project, s, {
          role: "error",
          text: stderr.trim() || `Claude Code stopped (exit code ${code})`,
        });
        s.status = "error";
      }
      this.opts.onChange(project);
    });
  }

  private onLine(project: string, s: Session, line: string) {
    let m: StreamMessage;
    try {
      m = JSON.parse(line) as StreamMessage;
    } catch {
      return;
    }
    if (m.type === "system" && m.subtype === "init" && m.session_id) {
      if (s.sessionId !== m.session_id) {
        s.sessionId = m.session_id;
        this.save();
      }
      return;
    }
    if (m.type === "assistant") {
      for (const block of m.message?.content ?? []) {
        if (block.type === "text" && block.text?.trim()) {
          s.turnText.push(block.text);
          const shown = block.text.replace(/```coanda[\s\S]*?```/g, "").trim();
          if (shown) this.push(project, s, { role: "assistant", text: shown });
        } else if (block.type === "tool_use") {
          this.push(project, s, { role: "tool", text: describeTool(block.name, block.input) });
        }
      }
      return;
    }
    if (m.type === "result") {
      const block = lastCoandaBlock(s.turnText.join("\n"));
      for (const r of block?.replies ?? []) {
        try {
          this.opts.onReply(r.video, Number(r.id), r.text);
        } catch (err) {
          this.push(project, s, { role: "error", text: (err as Error).message });
        }
      }
      if (m.is_error) {
        this.push(project, s, {
          role: "error",
          text: typeof m.result === "string" ? m.result : "Claude Code error",
        });
        s.status = "error";
      } else {
        s.status = block?.status === "question" ? "question" : "done";
      }
      s.turnText = [];
      this.save();
      this.opts.onChange(project);
    }
  }

  private push(project: string, s: Session, message: Omit<AgentMessage, "at">) {
    s.messages.push({ ...message, at: new Date().toISOString() });
    if (s.messages.length > MAX_MESSAGES) s.messages.splice(0, s.messages.length - MAX_MESSAGES);
    this.opts.onChange(project);
  }

  private loadSaved(): Record<string, { sessionId?: string; messages?: AgentMessage[] }> {
    const file = this.opts.sessionsFile;
    if (!existsSync(file)) return {};
    try {
      const all = JSON.parse(readFileSync(file, "utf8")) as Record<
        string,
        Record<string, { sessionId?: string; messages?: AgentMessage[] }>
      >;
      return all[this.opts.cwd.toLowerCase()] ?? {};
    } catch {
      return {};
    }
  }

  private save() {
    const file = this.opts.sessionsFile;
    let all: Record<string, unknown> = {};
    try {
      if (existsSync(file)) all = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      all = {};
    }
    const mine: Record<string, { sessionId?: string; messages: AgentMessage[] }> = {};
    for (const [project, s] of this.sessions) {
      if (s.sessionId || s.messages.length) {
        mine[project] = { sessionId: s.sessionId, messages: s.messages };
      }
    }
    all[this.opts.cwd.toLowerCase()] = mine;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
  }
}

interface StreamMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: unknown;
  message?: {
    content?: { type: string; text?: string; name?: string; input?: Record<string, unknown> }[];
  };
}

interface CoandaBlock {
  status?: string;
  replies?: { video: string; id: number; text: string }[];
}

function lastCoandaBlock(text: string): CoandaBlock | null {
  const blocks = [...text.matchAll(/```coanda\s*([\s\S]*?)```/g)];
  const last = blocks.at(-1);
  if (!last) return null;
  try {
    return JSON.parse(last[1]) as CoandaBlock;
  } catch {
    return null;
  }
}

/** One line describing a tool call, e.g. "Bash: node tools/render.mjs". */
function describeTool(name = "Tool", input: Record<string, unknown> = {}): string {
  const detail = [
    input.command,
    input.file_path,
    input.path,
    input.pattern,
    input.description,
  ].find((v): v is string => typeof v === "string" && v.length > 0);
  const text = detail?.split("\n")[0] ?? "";
  return text ? `${name}: ${text.length > 140 ? text.slice(0, 140) + "…" : text}` : name;
}
