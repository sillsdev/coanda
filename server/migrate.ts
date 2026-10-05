// HowReel was called Coanda and then HowBench, and review data written then still carries
// those names: the settings folder in the home folder, and beside reviewed files
// `<file>.<old>.json`, a `<file>.<old>` folder and a project's `.<old>` folder. These move to
// HowReel's names the first time HowReel sees them, and paths inside the moved JSON files are
// rewritten to match.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OLD = ["coanda", "howbench"];
const NEW = "howreel";

/** Points paths in a JSON file at the renamed folders, with either kind of slash. */
function rewritePaths(file: string): void {
  const text = readFileSync(file, "utf8");
  let next = text;
  for (const old of OLD) {
    next = next.replaceAll(`.${old}/`, `.${NEW}/`).replaceAll(`.${old}\\\\`, `.${NEW}\\\\`);
  }
  if (next !== text) writeFileSync(file, next);
}

const jsonIn = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f));

/** Moves ~/.coanda or ~/.howbench to ~/.howreel, when there is no ~/.howreel yet. */
export function moveOldSettings(): void {
  const to = join(homedir(), `.${NEW}`);
  for (const old of OLD.toReversed()) {
    const from = join(homedir(), `.${old}`);
    if (!existsSync(from) || existsSync(to)) continue;
    renameSync(from, to);
    for (const file of jsonIn(to)) rewritePaths(file);
  }
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
      const folderOf = OLD.find((old) => entry.name.endsWith(`.${old}`));
      const notesOf = OLD.find((old) => entry.name.endsWith(`.${old}.json`));
      if (entry.isDirectory()) {
        if (folderOf) {
          const to = full.slice(0, -folderOf.length) + NEW;
          if (existsSync(to)) continue;
          renameSync(full, to);
          for (const file of jsonIn(to)) rewritePaths(file);
        } else {
          walk(full);
        }
      } else if (notesOf) {
        const to = full.slice(0, -`${notesOf}.json`.length) + `${NEW}.json`;
        if (existsSync(to)) continue;
        rewritePaths(full);
        renameSync(full, to);
      }
    }
  };
  walk(root);
}
