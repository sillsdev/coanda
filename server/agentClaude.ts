// The Claude Code folder HowReel's video sessions use, given to them as CLAUDE_CONFIG_DIR. It has a
// login of its own, so the sessions can run on a different Claude account from the reviewer's
// other Claude Code work, and links to the reviewer's own setup in ~/.claude, so the sessions
// still have their instructions, skills, plugins, settings, transcripts and memory.
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What in ~/.claude is the reviewer's setup rather than one account's login or caches. */
const SHARED = [
  "CLAUDE.md",
  "settings.json",
  "keybindings.json",
  "statusline-command.sh",
  "agents",
  "commands",
  "skills",
  "plugins",
  "output-styles",
  "projects",
];

const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Makes `dir` ready to be a Claude Code folder: links each part of the reviewer's setup that
 * isn't there yet. A folder is linked as a junction. A file is linked when Windows allows it,
 * and otherwise copied, so a later change to the original doesn't reach the copy.
 */
export function prepareAgentClaudeDir(dir: string, from = join(homedir(), ".claude")): void {
  mkdirSync(dir, { recursive: true });
  for (const name of SHARED) {
    const source = join(from, name);
    const target = join(dir, name);
    if (!existsSync(source) || exists(target)) continue;
    if (statSync(source).isDirectory()) {
      symlinkSync(source, target, "junction");
      continue;
    }
    try {
      symlinkSync(source, target, "file");
    } catch {
      try {
        linkSync(source, target);
      } catch {
        copyFileSync(source, target);
      }
    }
  }
}
