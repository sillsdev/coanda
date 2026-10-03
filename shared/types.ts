// Types shared by the browser app and the local server.

/**
 * open: written but not yet sent to Claude.
 * sent: sent to Claude, no reply yet.
 * replied: Claude's message is the last one in the thread.
 * resolved: hidden unless the reviewer asks to see resolved annotations.
 */
export type AnnotationStatus = "open" | "sent" | "replied" | "resolved";

export interface ThreadMessage {
  who: "claude" | "user";
  /** Reviewer's name. Absent for Claude's messages. */
  author?: string;
  text: string;
  at: string;
  /** Claude's own status for this reply. Absent means done. */
  replyStatus?: ReplyStatus;
  /** Images the reviewer pasted in, relative to the reviewed folder. */
  images?: string[];
  /** When the reviewer last changed the text. */
  editedAt?: string;
}

/** done; partial: done with a caveat; voice: waiting on the voice switch; question: needs the
 * reviewer first. */
export type ReplyStatus = "done" | "partial" | "voice" | "question";

/**
 * Where a comment on a document sits: the text it quotes, with a little of the text before and
 * after to tell repeats apart, as in the W3C Web Annotation TextQuoteSelector. The text is the
 * document as displayed, without its Markdown markup.
 */
export interface TextQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

/**
 * A note on a video ("pin" or "arrow", at a time and a place on the frame) or a comment on a
 * document ("text", on a quoted passage).
 */
export interface Annotation {
  id: number;
  kind: "pin" | "arrow" | "text";
  /** The passage a document comment is on. Only for "text". */
  quote?: TextQuote;
  /** Position on the frame, as percentages of its width and height. 0 for "text". */
  x: number;
  y: number;
  /** Arrow tip, as percentages. Only for arrows. */
  x2?: number;
  y2?: number;
  /** Seconds into the video, as currently rendered. Moved by each render's time map. For "text",
   * where the passage starts in the displayed document, in characters, which orders comments. */
  t: number;
  /** Seconds into the render the note was made on, when a re-cut has moved it since. */
  tOriginal?: number;
  /** The note's moment was cut out of a later render; `t` is where the cut is. */
  cut?: boolean;
  author: string;
  text: string;
  status: AnnotationStatus;
  thread: ThreadMessage[];
  createdAt: string;
  /** Path of the saved frame image, relative to the reviewed folder. */
  frame?: string;
  /** Images the reviewer pasted in, relative to the reviewed folder. */
  images?: string[];
  /** When the reviewer last changed the text. */
  editedAt?: string;
}

export interface AnnotationFile {
  annotations: Annotation[];
  /** For a document: the reviewer approved it, as it was at `mtime`. */
  approved?: { by: string; at: string; mtime: number };
  /** Narration lines the current render has no recording for, as Claude last reported them. */
  unvoiced?: UnvoicedLine[];
  /** The render as it was when the reviewer last pressed Send, kept to compare against. */
  reviewed?: {
    copy: string;
    /** Its timeline file, when the pipeline wrote one. */
    timeline?: string;
  };
}

/**
 * A render's timeline, written by the pipeline beside the video as `<name>.timeline.json`: the
 * named moments in it (narration lines, actions) and when they happen. Coanda lines up the
 * reviewed render's timeline with the new one to move annotations after a re-cut. An anchor
 * with `say` is a narration line, and `say` is its words.
 */
export interface Timeline {
  anchors: { key: string; t: number; say?: string }[];
}

/** A stretch of the previous render and where it is in the new one, in seconds. Anything in
 * the previous render that no segment covers was cut. */
export interface TimeSegment {
  from: [number, number];
  to: [number, number];
}

/**
 * A narration line with no matching recording yet: new or reworded since the voice was last
 * made. The render leaves a gap where it goes until a voice pass records it.
 */
export interface UnvoicedLine {
  /** Where the line belongs in the current render, in seconds. */
  start: number;
  end: number;
  text: string;
}

/** Per-video information beyond its annotations. */
export interface VideoInfo {
  unvoiced: UnvoicedLine[];
  /** Subtitle files beside the video (`<name>.srt`, `<name>.en.vtt`, …), relative paths. */
  subtitles: string[];
}

export interface TreeNode {
  name: string;
  /** Path relative to the reviewed folder, with forward slashes. */
  path: string;
  /** file: any other file, shown so the whole folder can be browsed. */
  kind: "folder" | "video" | "file";
  children?: TreeNode[];
  /** Annotations on this video or document that are not resolved. */
  unresolved?: number;
  /** Annotations on this video or document waiting to be sent. */
  open?: number;
  /** Annotations on this video or document sent to Claude and not yet answered. */
  sent?: number;
  /** Last modification time of the file, in ms since the epoch. */
  mtime?: number;
  /** A folder holding a video-project.json: a video project with its own Claude session. */
  project?: boolean;
  /** For a project folder, what its Claude session is doing. */
  agentStatus?: AgentStatus;
  /** A project's planning document: its step number, from 1. */
  step?: number;
}

/**
 * idle: no turn has run since Coanda started. working: Claude is on a turn.
 * done: Claude finished its turn. question: Claude finished and needs the reviewer.
 * error: the turn failed or Claude Code stopped.
 */
export type AgentStatus = "idle" | "working" | "done" | "question" | "error";

export interface AgentMessage {
  role: "user" | "assistant" | "tool" | "error";
  text: string;
  at: string;
  /** Images the reviewer pasted into the message, relative to the reviewed folder. */
  images?: string[];
}

export interface AgentState {
  status: AgentStatus;
  messages: AgentMessage[];
  sessionId?: string;
  /** The model the session is running, as Claude Code reports it. */
  model?: string;
  /** Tokens in the conversation's context after the latest message. */
  contextTokens?: number;
  /** The model's context window, in tokens. */
  contextWindow?: number;
  /** The Claude account's usage limits, from the latest report by any session. */
  limits?: UsageLimits;
  /** While working: when the work started, for showing how long it has taken. */
  workingSince?: string;
}

export interface UsageWindow {
  /** Fraction used, 0 to 1. */
  utilization: number;
  /** When the window resets, in seconds since the epoch. */
  resetsAt: number;
}

export interface UsageLimits {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
}

/** A project's per-machine settings. */
export interface ProjectSettings {
  /** The BloomDesktop worktree the project's session runs Bloom from. */
  bloom?: string;
  /** Model alias or name for `claude --model`; absent for Claude Code's default. */
  model?: string;
  /** `claude --effort` level; absent for the default. */
  effort?: string;
}

export interface ClaudeAuth {
  loggedIn: boolean;
  email?: string;
}

export interface ServerInfo {
  /** Absolute path of the folder being reviewed, or null before one is chosen. */
  root: string | null;
  rootName: string;
  user: string;
  /** Folders reviewed recently, most recent first. */
  recent: string[];
}

/** What `coanda wait` prints: one entry per annotation sent to Claude. */
export interface SentAnnotation extends Annotation {
  video: string;
  /** Absolute path of the video file. */
  videoFile: string;
  /** Absolute path of the frame image, when one was saved. */
  frameFile?: string;
}

/** Events the server pushes to the browser over /api/events. */
export type ServerEvent =
  | { type: "annotations"; video: string }
  | { type: "tree" }
  | { type: "video-changed"; video: string }
  /** A document changed on disk. */
  | { type: "doc-changed"; path: string }
  /** A project's questions from Claude changed. */
  | { type: "questions"; project: string }
  | { type: "status" }
  | { type: "root" }
  | { type: "agent"; project: string };

/** The documents a video is planned in, in the order they're written, each built on the last. */
export const PLANNING_STEPS = [
  { key: "brief", title: "Brief", file: "brief.md" },
  { key: "outline", title: "Outline", file: "outline.md" },
  { key: "script", title: "Script", file: "script.md" },
] as const;

export type PlanningStepKey = (typeof PLANNING_STEPS)[number]["key"];

/** A planning document's state in a project. */
export interface PlanningStep {
  key: PlanningStepKey;
  title: string;
  /** The document, relative to the reviewed folder. */
  path: string;
  exists: boolean;
  approved?: { by: string; at: string };
  /** Approved, then changed. */
  changedSinceApproval: boolean;
  /** Comments not yet resolved. */
  unresolved: number;
}

/**
 * A question Claude asks the reviewer, shown in the annotations list with its own place to
 * answer. The answer goes to Claude with the next Send.
 */
export interface AgentQuestion {
  id: number;
  text: string;
  /** Answers to offer as buttons; the reviewer can always type another. */
  options: string[];
  askedAt: string;
  answer?: { text: string; by: string; at: string };
  /** The answer has gone to Claude. */
  sent?: boolean;
}

/** A document's text, and when it was last saved, to detect a change made meanwhile. */
export interface DocText {
  text: string;
  mtime: number;
}

export interface ServerStatus {
  /** True while a `coanda wait` is connected. */
  waiting: boolean;
  /** Sent annotations that no `coanda wait` has collected yet. */
  undelivered: number;
}
