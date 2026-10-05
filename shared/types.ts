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
}

export interface Annotation {
  id: number;
  kind: "pin" | "arrow";
  /** Position on the frame, as percentages of its width and height. */
  x: number;
  y: number;
  /** Arrow tip, as percentages. Only for arrows. */
  x2?: number;
  y2?: number;
  /** Seconds into the video. */
  t: number;
  author: string;
  text: string;
  status: AnnotationStatus;
  thread: ThreadMessage[];
  createdAt: string;
  /** Path of the saved frame image, relative to the reviewed folder. */
  frame?: string;
}

export interface AnnotationFile {
  annotations: Annotation[];
  /**
   * Whether the video is ready for its voice-over. Off by default: until it is on, Claude
   * re-renders with the existing narration instead of paying to generate new voice audio.
   */
  voiceReady?: boolean;
}

/** Per-video information beyond its annotations. */
export interface VideoInfo {
  voiceReady: boolean;
  /** Subtitle files beside the video (`<name>.srt`, `<name>.en.vtt`, …), relative paths. */
  subtitles: string[];
}

export interface TreeNode {
  name: string;
  /** Path relative to the reviewed folder, with forward slashes. */
  path: string;
  kind: "folder" | "video";
  children?: TreeNode[];
  /** Annotations on this video that are not resolved. */
  unresolved?: number;
  /** Annotations on this video waiting to be sent. */
  open?: number;
  /** Annotations on this video sent to Claude and not yet answered. */
  sent?: number;
  /** Last modification time of the video file, in ms since the epoch. */
  mtime?: number;
  /** A folder holding a video-project.json: a video project with its own Claude session. */
  project?: boolean;
  /** For a project folder, what its Claude session is doing. */
  agentStatus?: AgentStatus;
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
}

export interface AgentState {
  status: AgentStatus;
  messages: AgentMessage[];
  sessionId?: string;
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
  /** The video's "Ready for voice" switch when this was sent. */
  voiceReady: boolean;
}

/** Events the server pushes to the browser over /api/events. */
export type ServerEvent =
  | { type: "annotations"; video: string }
  | { type: "tree" }
  | { type: "video-changed"; video: string }
  | { type: "status" }
  | { type: "root" }
  | { type: "agent"; project: string };

export interface ServerStatus {
  /** True while a `coanda wait` is connected. */
  waiting: boolean;
  /** Sent annotations that no `coanda wait` has collected yet. */
  undelivered: number;
}
