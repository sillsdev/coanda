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
