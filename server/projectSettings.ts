// Settings for a video project that belong to this machine, not to the project's files:
// the folder of the app its videos are about. Kept in ~/.howreel/projects.json, keyed by
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
    // Settings saved when the app could only be Bloom name its folder `bloom`.
    const { bloom, ...settings } = (this.all()[key(projectDir)] ?? {}) as ProjectSettings & {
      bloom?: string;
    };
    return bloom && !settings.app ? { ...settings, app: bloom } : settings;
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

/** How to start a project's Claude session so it works with the app in `app`. */
export function appLaunch(app: string): ProjectLaunch {
  return {
    args: ["--add-dir", app],
    instructions: `This project's videos are about the app in ${app}. Before building or running
it, read that folder's AGENTS.md and CLAUDE.md, where they exist, and run and drive the app as
they say. Other copies of the app may be running from other folders at the same time: never
stop one you didn't start.

${
  existsSync(join(app, ".git"))
    ? `That folder is a git checkout of the app's source, so the reviewer develops the app: its
skills are yours to fix, as "Fix the tools you use" says. Sessions working in it are named
after its folder ("${basename(app)}-…").`
    : `That folder is not a git checkout, so its skills can't be fixed there: say a problem
with them in a line instead.`
}`,
  };
}
