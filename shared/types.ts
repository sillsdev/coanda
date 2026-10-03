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
}

export interface ServerInfo {
  root: string;
  rootName: string;
  user: string;
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
  | { type: "status" };

export interface ServerStatus {
  /** True while a `coanda wait` is connected. */
  waiting: boolean;
  /** Sent annotations that no `coanda wait` has collected yet. */
  undelivered: number;
}
