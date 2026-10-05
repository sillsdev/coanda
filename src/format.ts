import type { TreeNode } from "../shared/types.ts";

/** 75.4 → "1:15" */
export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const AVATAR_COLORS = ["#2f5fc4", "#1f3f86", "#142a58", "#4a7fe0"];

/** A stable avatar background for a reviewer's name. */
export function avatarColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function stem(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

export function findNode(nodes: TreeNode[], path: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.path === path) return n;
    const inner = n.children && findNode(n.children, path);
    if (inner) return inner;
  }
  return undefined;
}

/** The most recently changed video among the nodes and everything under them. */
export function newestVideo(nodes: TreeNode[]): TreeNode | undefined {
  let newest: TreeNode | undefined;
  for (const n of nodes) {
    const candidate = n.kind === "video" ? n : n.children && newestVideo(n.children);
    if (candidate && (candidate.mtime ?? 0) > (newest?.mtime ?? 0)) newest = candidate;
  }
  return newest;
}

/** "claude-opus-5-5" → "Opus 5.5"; "claude-haiku-4-5-20251001" → "Haiku 4.5". Anything else,
 * such as an alias, is shown as it is. */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
}

/** Files HowBench opens as documents, as the server decides. */
export function isDocument(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

export function isImage(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
}

/** Files HowBench shows as they are, without notes: images and JSON. */
export function isViewable(path: string): boolean {
  return isImage(path) || path.toLowerCase().endsWith(".json");
}

/**
 * A count over the videos and documents in these nodes and the folders below them, leaving out
 * every folder that is a project of its own, as Send does.
 */
export function sumOwned(nodes: TreeNode[], pick: (n: TreeNode) => number): number {
  return nodes.reduce(
    (sum, n) =>
      sum + (n.kind !== "folder" ? pick(n) : n.project ? 0 : sumOwned(n.children ?? [], pick)),
    0,
  );
}
