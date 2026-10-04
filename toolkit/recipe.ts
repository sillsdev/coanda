// Finding a project's recipe, video-project.json, from anywhere inside the project.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PROJECT_FILE } from "../server/store.ts";

/** The folder holding video-project.json, at or above `dir`, and what it says. Outside any
 * project, `dir` itself and an empty recipe. */
export function findRecipe(dir: string): { projectDir: string; recipe: Record<string, unknown> } {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const file = join(d, PROJECT_FILE);
    if (existsSync(file)) {
      return {
        projectDir: d,
        recipe: JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>,
      };
    }
    if (dirname(d) === d) return { projectDir: resolve(dir), recipe: {} };
  }
}
