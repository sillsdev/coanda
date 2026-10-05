// Settings for a video project that belong to this machine, not to the project's files:
// which Bloom worktree its Claude session drives. Kept in ~/.howbench/projects.json, keyed by
// the project folder's absolute path.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProjectSettings } from "../shared/types.ts";
import type { ProjectLaunch } from "./agents.ts";

export class ProjectSettingsStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  get(projectDir: string): ProjectSettings {
    return this.all()[key(projectDir)] ?? {};
  }

  set(projectDir: string, settings: ProjectSettings): void {
    const all = this.all();
    all[key(projectDir)] = settings;
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(this.file, JSON.stringify(all, null, 2) + "\n");
  }

  private all(): Record<string, ProjectSettings> {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, ProjectSettings>;
    } catch {
      return {};
    }
  }
}

const key = (dir: string) => dir.replace(/\\/g, "/").toLowerCase();

/** How to start a project's Claude session so it uses the project's Bloom worktree. */
export function bloomLaunch(bloom: string): ProjectLaunch {
  return {
    args: ["--add-dir", bloom],
    instructions: `This project's Bloom is the BloomDesktop worktree at ${bloom}. Run and drive
Bloom only from there, with its run-bloom skill: read ${bloom}/.claude/skills/run-bloom/SKILL.md
(and ${bloom}/AGENTS.md for building) before starting Bloom. Other worktrees may have their own
Bloom running at the same time, so never assume port 8089 or any fixed port: take httpPort and
cdpPort from \`node .claude/skills/run-bloom/launcherControl.mjs --status --json\` run in that
worktree, and never stop a Bloom that another worktree started.

${
  existsSync(join(bloom, ".git"))
    ? `That worktree is a git checkout of Bloom's source, so the reviewer develops Bloom: its
skills are yours to fix, as "Fix the tools you use" says. Sessions working in it are named
after its folder ("${basename(bloom)}-…").`
    : `That folder is not a git checkout, so its skills can't be fixed there: say a problem
with them in a line instead.`
}`,
  };
}
