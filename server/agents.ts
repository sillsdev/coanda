// One long-running Claude Code process per video project, driven over stream-json.
//
// The process is `claude -p --input-format stream-json --output-format stream-json`, which
// keeps one conversation open and takes message after message on stdin. Its session ID is
// saved, so after a restart `--resume` picks the same conversation back up.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validSegments } from "./timeMap.ts";
import type {
  AgentMessage,
  AgentState,
  AgentStatus,
  TimeSegment,
  UnvoicedLine,
  UsageLimits,
  UsageWindow,
} from "../shared/types.ts";

/** Coanda's instructions to every video session, kept in agent/guidance.md and read each time a
 * session starts, so edits to it reach the next session without rebuilding anything. */
const GUIDANCE_FILE = fileURLToPath(new URL("../agent/guidance.md", import.meta.url));

const COANDA_DIR = fileURLToPath(new URL("..", import.meta.url))
  .replaceAll("\\", "/")
  .replace(/\/$/, "");

/** Whether Coanda runs from its source, where its developer works on it, or is just installed. */
function coandaSituation(): string {
  return existsSync(join(COANDA_DIR, ".git"))
    ? `Coanda is running from its source code, a git checkout at ${COANDA_DIR}. Its developer ` +
        `works on it with Claude Code, in sessions named after the folder ` +
        `("${basename(COANDA_DIR)}-…").`
    : "Coanda is installed here, not run from its source: nobody on this machine works on " +
        "Coanda's code, so there is no session to send Coanda's problems to.";
}

function guidance(): string {
  try {
    // `<coanda>` in the guidance stands for the Coanda folder and `<node>` for the Node that
    // runs Coanda, so it can name Coanda's commands. Coanda needs a newer Node than a project's
    // PATH may find.
    const text = readFileSync(GUIDANCE_FILE, "utf8")
      .replaceAll("<coanda>", COANDA_DIR)
      .replaceAll("<node>", process.execPath.replaceAll("\\", "/"));
    return `${text}\n\n## Where you are\n\n${coandaSituation()}`;
  } catch {
    return FALLBACK_GUIDANCE;
  }
}

const FALLBACK_GUIDANCE = `You are working with a reviewer through Coanda, a video review app.
Coanda's full instructions (agent/guidance.md in the Coanda repo) could not be read. Answer each
annotation you are sent, end each turn with a fenced coanda block of replies, and do not
generate voice-over or publish anything unless the reviewer asks for it in words.`;

const MAX_MESSAGES = 400;

interface Session {
  status: AgentStatus;
  sessionId?: string;
  messages: AgentMessage[];
  proc?: ChildProcessWithoutNullStreams;
  /** Text of the assistant messages since the last result, for finding the coanda block. A
   * message sent while a turn is under way leaves it alone, so that turn's block still counts. */
  turnText: string[];
  model?: string;
  contextTokens?: number;
  contextWindow?: number;
  /** The instructions this conversation has: what its recorded system prompt holds, plus any
   * update sent since in a message. */
  instructions?: string;
  /** The last message sent other than a slash command, as given to send: what a session cut off
   * mid-turn is reminded of, shown in the chat or not. */
  lastSent?: string;
  /** The instructions the running process was started with. */
  procInstructions?: string;
  /**
   * Messages sent to the running process, and how many of those it has started on (it echoes
   * each one as it takes it up). A turn's result only ends the work once every message has
   * started: resuming a conversation whose turn was cut off first ends that turn, with a result
   * of its own.
   */
  sent?: number;
  started?: number;
  /** When the session last went from not working to working. */
  workingSince?: string;
  /** The turn running is Claude Code's /compact. */
  compacting?: boolean;
  saveTimer?: ReturnType<typeof setTimeout>;
}

export interface ProjectLaunch {
  args?: string[];
  env?: Record<string, string>;
  /** Added to Coanda's instructions for this project. */
  instructions?: string;
}

export interface AgentOptions {
  /** Folder the agents work in: the reviewed folder. */
  cwd: string;
  /** How to run Claude Code; the tests substitute a stand-in. */
  command: string[];
  /** Where session IDs and transcripts are kept between runs. */
  sessionsFile: string;
  env?: Record<string, string>;
  /** Extra arguments, environment and instructions for one project's process. */
  launch?: (project: string) => ProjectLaunch;
  onChange: (project: string) => void;
  onReply: (video: string, id: number, reply: CoandaReply) => void;
  /** A rendered video's time map: Coanda moves the video's annotations along it. */
  onTimeMap: (video: string, segments: TimeSegment[]) => void;
  /** A video was rendered this turn (it has an `unvoiced` entry) and came with no time map. */
  onRenderedWithoutMap: (video: string) => void;
  /** The unvoiced lines of a video Claude just rendered; an empty list means all are voiced. */
  onUnvoiced: (video: string, lines: UnvoicedLine[]) => void;
  /** Questions Claude asked the reviewer this turn. */
  onQuestions: (project: string, questions: { text: string; options: string[] }[]) => void;
}

export class AgentManager {
  private sessions = new Map<string, Session>();
  /** Usage limits belong to the Claude account, so one copy serves every session. */
  private limits: UsageLimits = {};
  private opts: AgentOptions;
  /** Set by stopAll: this manager's processes are gone and another may own the sessions file. */
  private stopped = false;

  constructor(opts: AgentOptions) {
    this.opts = opts;
    const interrupted: string[] = [];
    for (const [project, saved] of Object.entries(this.loadSaved())) {
      if (saved.working) interrupted.push(project);
      this.sessions.set(project, {
        status: "idle",
        sessionId: saved.sessionId,
        messages: saved.messages ?? [],
        turnText: [],
        model: saved.model,
        contextTokens: saved.contextTokens,
        contextWindow: saved.contextWindow,
        instructions: saved.instructions,
        lastSent: saved.lastSent,
      });
    }
    // Sessions that Coanda stopped mid-turn carry on, once whoever made this manager has it.
    setTimeout(() => {
      if (this.stopped) return;
      for (const project of interrupted) this.resumeInterrupted(project);
    }, 0);
  }

  /** Restarts a session whose turn was cut off when Coanda stopped, telling it so. */
  private resumeInterrupted(project: string): void {
    const s = this.sessions.get(project);
    if (!s || s.proc) return;
    const last = s.lastSent ?? s.messages.findLast((m) => m.role === "user")?.text;
    this.send(
      project,
      "[Coanda] Coanda was restarted while you were working, which cut your turn off. Carry on " +
        "from where you were, starting with a line saying what you're doing." +
        (last ? ` In case it didn't reach you, the reviewer's last message was:\n\n${last}` : ""),
      "Coanda restarted during this turn. Carrying on.",
    );
    s.lastSent = last;
    this.save();
  }

  state(project: string): AgentState {
    const s = this.sessions.get(project);
    return {
      status: s?.status ?? "idle",
      messages: s?.messages ?? [],
      sessionId: s?.sessionId,
      model: s?.model,
      contextTokens: s?.contextTokens,
      contextWindow: s?.contextWindow,
      limits: this.limits,
      ...(s?.status === "working" && s.workingSince ? { workingSince: s.workingSince } : {}),
      ...(s?.status === "working" && s.compacting ? { compacting: true } : {}),
    };
  }

  status(project: string): AgentStatus {
    return this.sessions.get(project)?.status ?? "idle";
  }

  /** Sends a message to the project's session. `shown` is what the chat shows of it, with
   * `images` the reviewer pasted in; null when the chat shows it some other way. */
  send(project: string, text: string, shown: string | null = text, images: string[] = []): void {
    const s = this.session(project);
    if (!s.proc) this.start(project, s);
    // Claude Code records a conversation's system prompt when it begins and re-sends that record
    // on every resume, so instructions changed since then have to travel in a message.
    // A slash command only runs when it starts the message, so it goes on its own, and changed
    // instructions wait for the next ordinary message.
    if (!text.trimStart().startsWith("/")) s.lastSent = text;
    const current = this.instructionsFor(project);
    if (s.sessionId && s.instructions !== current && !text.trimStart().startsWith("/")) {
      text =
        "[Coanda] Coanda's instructions to you have changed since this conversation began. " +
        "These replace the earlier ones:\n\n" +
        current +
        "\n\n---\n\n" +
        text;
      s.instructions = current;
      this.save();
    }
    if (shown !== null) {
      this.push(project, s, { role: "user", text: shown, ...(images.length ? { images } : {}) });
    }
    // Slash commands aren't echoed, so they aren't counted.
    if (!text.trimStart().startsWith("/")) s.sent = (s.sent ?? 0) + 1;
    if (s.status !== "working") s.workingSince = new Date().toISOString();
    s.status = "working";
    s.compacting = text.trim() === "/compact";
    // On disk at once, so a Coanda stopped from now on knows to carry on with this turn.
    this.save();
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
    // Saved, so a stopped turn is not carried on when the folder is next opened.
    this.save();
    this.opts.onChange(project);
  }

  /** Stops the process if it is idle between turns, so the next message starts it afresh
   * with new settings. A turn in progress is left to finish. */
  restartWhenIdle(project: string): void {
    const s = this.sessions.get(project);
    if (s?.proc && s.status !== "working") {
      s.proc.kill();
      s.proc = undefined;
    }
  }

  /** Stops every process as Coanda shuts down. A session that was working stays marked so,
   * and carries on when Coanda next opens this folder. */
  stopAll(): void {
    for (const s of this.sessions.values()) {
      const proc = s.proc;
      s.proc = undefined;
      proc?.kill();
      clearTimeout(s.saveTimer);
    }
    this.save();
    this.stopped = true;
  }

  /** Coanda's guidance plus the project's own instructions, as a session should have them now. */
  private instructionsFor(project: string, extra = this.opts.launch?.(project) ?? {}): string {
    return extra.instructions ? `${guidance()}\n\n${extra.instructions}` : guidance();
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
    const extra = this.opts.launch?.(project) ?? {};
    const instructions = this.instructionsFor(project, extra);
    s.procInstructions = instructions;
    // A new conversation records these as its system prompt; a resumed one keeps its record.
    if (!s.sessionId) s.instructions = instructions;
    // They go in a file: as an argument they'd outgrow Windows' limit on a command line.
    const instructionsFile = join(
      dirname(this.opts.sessionsFile),
      "instructions",
      `${createHash("sha256").update(project).digest("hex").slice(0, 16)}.md`,
    );
    mkdirSync(dirname(instructionsFile), { recursive: true });
    writeFileSync(instructionsFile, instructions);
    const args = [
      ...base,
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--replay-user-messages",
      "--permission-mode",
      "auto",
      "--append-system-prompt-file",
      instructionsFile,
      ...(extra.args ?? []),
      ...(s.sessionId ? ["--resume", s.sessionId] : []),
    ];
    s.sent = 0;
    s.started = 0;
    s.turnText = [];
    const proc = spawn(cmd, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env, ...extra.env },
      windowsHide: true,
    });
    s.proc = proc;

    let buffer = "";
    // Output from a process that has been stopped or replaced is dropped: it may arrive after
    // Coanda has moved to another folder.
    proc.stdout.on("data", (chunk: Buffer) => {
      if (s.proc !== proc) return;
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line && s.proc === proc) this.onLine(project, s, line);
      }
    });
    // Writing to a process that failed to start errors here; the process's own 'error' below
    // reports the failure.
    proc.stdin.on("error", () => {});
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    proc.on("error", (err) => {
      if (s.proc !== proc) return;
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
      if (m.model) s.model = m.model;
      if (s.sessionId !== m.session_id) s.sessionId = m.session_id;
      this.save();
      this.opts.onChange(project);
      return;
    }
    if (m.type === "user" && m.isReplay) {
      if (
        typeof m.message?.content !== "string" ||
        !m.message.content.trimStart().startsWith("/")
      ) {
        s.started = (s.started ?? 0) + 1;
      }
      return;
    }
    if (m.type === "user" && typeof m.message?.content === "string") {
      // Output of a command typed in the panel, such as /context. Compaction's own output is
      // reported by compact_boundary below instead.
      const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(
        m.message.content,
      )?.[1];
      if (out?.trim() && !out.trimStart().startsWith("Compacted")) {
        this.push(project, s, { role: "tool", text: out.trim() });
      }
      return;
    }
    if (m.type === "system" && m.subtype === "compact_boundary") {
      const meta = m.compact_metadata;
      if (typeof meta?.post_tokens === "number") s.contextTokens = meta.post_tokens;
      // Compacting records the system prompt afresh, from the text this process started with.
      if (s.procInstructions) s.instructions = s.procInstructions;
      if (meta?.pre_tokens !== undefined && meta.post_tokens !== undefined) {
        this.push(project, s, {
          role: "tool",
          text: `Compacted: ${meta.pre_tokens.toLocaleString()} → ${meta.post_tokens.toLocaleString()} tokens`,
        });
      }
      this.save();
      return;
    }
    if (m.type === "rate_limit_event") {
      const windows = m.rate_limit_info?.unifiedWindows;
      const read = (w?: UsageWindow) =>
        w && typeof w.utilization === "number"
          ? { utilization: w.utilization, resetsAt: w.resetsAt }
          : undefined;
      this.limits = {
        fiveHour: read(windows?.five_hour) ?? this.limits.fiveHour,
        sevenDay: read(windows?.seven_day) ?? this.limits.sevenDay,
      };
      this.opts.onChange(project);
      return;
    }
    if (m.type === "assistant") {
      const u = m.message?.usage;
      if (u) {
        s.contextTokens =
          (u.input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.output_tokens ?? 0);
      }
      const content = m.message?.content;
      for (const block of Array.isArray(content) ? content : []) {
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
      const windows = Object.values(m.modelUsage ?? {})
        .map((x) => x.contextWindow)
        .filter((n): n is number => typeof n === "number");
      if (windows.length) s.contextWindow = Math.max(...windows);
      const block = lastCoandaBlock(s.turnText.join("\n"));
      for (const [video, raw] of Object.entries(block?.timeMap ?? {})) {
        const segments = validSegments(raw);
        if (!segments.length) continue;
        try {
          this.opts.onTimeMap(video, segments);
        } catch (err) {
          this.push(project, s, { role: "error", text: (err as Error).message });
        }
      }
      for (const video of Object.keys(block?.unvoiced ?? {})) {
        if (block?.timeMap?.[video]) continue;
        try {
          this.opts.onRenderedWithoutMap(video);
        } catch (err) {
          this.push(project, s, { role: "error", text: (err as Error).message });
        }
      }
      for (const [video, lines] of Object.entries(block?.unvoiced ?? {})) {
        if (!Array.isArray(lines)) continue;
        try {
          this.opts.onUnvoiced(
            video,
            lines
              .filter((l) => typeof l?.start === "number" && typeof l?.end === "number")
              .map((l) => ({ start: l.start, end: l.end, text: String(l.text ?? "") })),
          );
        } catch (err) {
          this.push(project, s, { role: "error", text: (err as Error).message });
        }
      }
      const questions = (Array.isArray(block?.questions) ? block.questions : [])
        .filter((q) => typeof q?.text === "string" && q.text.trim())
        .map((q) => ({
          text: (q.text as string).trim(),
          options: Array.isArray(q.options)
            ? q.options.filter((o): o is string => typeof o === "string" && !!o.trim())
            : [],
        }));
      if (questions.length) {
        try {
          this.opts.onQuestions(project, questions);
        } catch (err) {
          this.push(project, s, { role: "error", text: (err as Error).message });
        }
      }
      for (const r of block?.replies ?? []) {
        try {
          this.opts.onReply(r.video, Number(r.id), r);
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
      } else if ((s.started ?? 0) >= (s.sent ?? 0)) {
        s.status = block?.status === "question" || questions.length ? "question" : "done";
      }
      s.turnText = [];
      this.save();
      this.opts.onChange(project);
    }
  }

  private push(project: string, s: Session, message: Omit<AgentMessage, "at">) {
    s.messages.push({ ...message, at: new Date().toISOString() });
    if (s.messages.length > MAX_MESSAGES) s.messages.splice(0, s.messages.length - MAX_MESSAGES);
    // Keep the transcript on disk as it grows, so stopping Coanda mid-turn loses none of it.
    clearTimeout(s.saveTimer);
    s.saveTimer = setTimeout(() => this.save(), 1000);
    this.opts.onChange(project);
  }

  private loadSaved(): Record<string, SavedSession> {
    const file = this.opts.sessionsFile;
    if (!existsSync(file)) return {};
    try {
      const all = JSON.parse(readFileSync(file, "utf8")) as Record<
        string,
        Record<string, SavedSession>
      >;
      return all[this.opts.cwd.toLowerCase()] ?? {};
    } catch {
      return {};
    }
  }

  private save() {
    if (this.stopped) return;
    const file = this.opts.sessionsFile;
    let all: Record<string, unknown> = {};
    try {
      if (existsSync(file)) all = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      all = {};
    }
    const mine: Record<string, SavedSession> = {};
    for (const [project, s] of this.sessions) {
      if (s.sessionId || s.messages.length) {
        mine[project] = {
          sessionId: s.sessionId,
          messages: s.messages,
          model: s.model,
          contextTokens: s.contextTokens,
          contextWindow: s.contextWindow,
          instructions: s.instructions,
          lastSent: s.lastSent,
          working: s.status === "working",
        };
      }
    }
    all[this.opts.cwd.toLowerCase()] = mine;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
  }
}

interface SavedSession {
  sessionId?: string;
  messages?: AgentMessage[];
  model?: string;
  contextTokens?: number;
  contextWindow?: number;
  instructions?: string;
  lastSent?: string;
  /** It was working when last saved: Coanda stopped in the middle of its turn. */
  working?: boolean;
}

interface StreamMessage {
  type: string;
  subtype?: string;
  /** On a user message: Claude Code echoing a message it was sent, as it starts on it. */
  isReplay?: boolean;
  session_id?: string;
  model?: string;
  is_error?: boolean;
  result?: unknown;
  message?: {
    /** Blocks for Claude's messages; a plain string for echoed user input and command output. */
    content?:
      | string
      | { type: string; text?: string; name?: string; input?: Record<string, unknown> }[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  modelUsage?: Record<string, { contextWindow?: number }>;
  compact_metadata?: { pre_tokens?: number; post_tokens?: number };
  rate_limit_info?: {
    unifiedWindows?: { five_hour?: UsageWindow; seven_day?: UsageWindow };
  };
}

/** One reply in a turn's coanda block. */
export interface CoandaReply {
  video: string;
  id: number;
  text: string;
  status?: string;
  /** The note's moment in the new render, in seconds, when a re-cut moved it. */
  t?: number;
}

interface CoandaBlock {
  /** Per video rendered with different timing, how the previous render's times map to the new. */
  timeMap?: Record<string, unknown>;
  /** Per video rendered this turn, its complete list of unvoiced lines. */
  unvoiced?: Record<string, UnvoicedLine[]>;
  status?: string;
  replies?: CoandaReply[];
  /** Questions for the reviewer, each answered on its own. */
  questions?: { text?: unknown; options?: unknown }[];
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
