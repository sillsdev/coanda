// Howbench was called Coanda, and review data written then still carries that name: the
// settings folder in the home folder, and beside reviewed files `<file>.coanda.json`, a
// `<file>.coanda` folder and a project's `.coanda` folder. These move to Howbench's names the
// first time Howbench sees them, and paths inside the moved JSON files are rewritten to match.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OLD = "coanda";
const NEW = "howbench";

/** Points paths in a JSON file at the renamed folders, with either kind of slash. */
function rewritePaths(file: string): void {
  const text = readFileSync(file, "utf8");
  const next = text.replaceAll(`.${OLD}/`, `.${NEW}/`).replaceAll(`.${OLD}\\\\`, `.${NEW}\\\\`);
  if (next !== text) writeFileSync(file, next);
}

const jsonIn = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f));

/** Moves ~/.coanda to ~/.howbench, when only the old one exists. */
export function moveOldSettings(): void {
  const from = join(homedir(), `.${OLD}`);
  const to = join(homedir(), `.${NEW}`);
  if (!existsSync(from) || existsSync(to)) return;
  renameSync(from, to);
  for (const file of jsonIn(to)) rewritePaths(file);
}

/** Renames the old review files and folders under `root`, leaving any that would replace
 * something already there. */
export function moveOldReviewFiles(root: string): void {
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith(`.${OLD}`)) {
          const to = full.slice(0, -OLD.length) + NEW;
          if (existsSync(to)) continue;
          renameSync(full, to);
          for (const file of jsonIn(to)) rewritePaths(file);
        } else {
          walk(full);
        }
      } else if (entry.name.endsWith(`.${OLD}.json`)) {
        const to = full.slice(0, -`${OLD}.json`.length) + `${NEW}.json`;
        if (existsSync(to)) continue;
        rewritePaths(full);
        renameSync(full, to);
      }
    }
  };
  walk(root);
}
