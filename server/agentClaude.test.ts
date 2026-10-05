import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { prepareAgentClaudeDir } from "./agentClaude.ts";

let home: string;
let from: string;
let dir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "howreel-claude-"));
  from = join(home, "shared");
  dir = join(home, "agents");
  mkdirSync(join(from, "skills", "run-app"), { recursive: true });
  writeFileSync(join(from, "skills", "run-app", "SKILL.md"), "run it");
  writeFileSync(join(from, "CLAUDE.md"), "be brief");
  writeFileSync(join(from, ".credentials.json"), "{}");
});

afterEach(() => {
  // The linked folder goes as a link, never followed into the original.
  if (existsSync(join(dir, "skills"))) unlinkSync(join(dir, "skills"));
  rmSync(home, { recursive: true, force: true });
});

test("the sessions' folder links the reviewer's setup, and not their login", () => {
  prepareAgentClaudeDir(dir, from);
  expect(readFileSync(join(dir, "skills", "run-app", "SKILL.md"), "utf8")).toBe("run it");
  expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("be brief");
  expect(existsSync(join(dir, ".credentials.json"))).toBe(false);

  // A skill added later reaches the sessions through the link.
  writeFileSync(join(from, "skills", "new.md"), "new");
  expect(existsSync(join(dir, "skills", "new.md"))).toBe(true);
  // Running it again keeps what's there.
  prepareAgentClaudeDir(dir, from);
});
