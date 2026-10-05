// Settings kept between runs: the folder being reviewed and the folders used recently.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Config {
  root?: string;
  /** Most recent first, including the current root. */
  recent: string[];
}

const MAX_RECENT = 8;

export function defaultConfigFile(): string {
  return process.env.HOWBENCH_CONFIG ?? join(homedir(), ".howbench", "config.json");
}

export function loadConfig(file: string): Config {
  if (!existsSync(file)) return { recent: [] };
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<Config>;
    return { root: data.root, recent: Array.isArray(data.recent) ? data.recent : [] };
  } catch {
    return { recent: [] };
  }
}

export function saveConfig(file: string, config: Config): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
}

/** Makes `root` the current folder and moves it to the front of the recent list. */
export function withRoot(config: Config, root: string): Config {
  const same = (a: string) => a.toLowerCase() === root.toLowerCase();
  return { root, recent: [root, ...config.recent.filter((r) => !same(r))].slice(0, MAX_RECENT) };
}
