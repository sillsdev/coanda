// Reads the reviewed folder and the annotation files kept next to each video.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Annotation, AnnotationFile, TreeNode } from "../shared/types.ts";

export const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov", ".m4v", ".ogv"];

export function isVideoFile(name: string): boolean {
  const lower = name.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** A folder holding this file is a video project, with its own Claude session. */
export const PROJECT_FILE = "video-project.json";

export class Store {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Resolves a path relative to the root, refusing anything outside it. */
  resolvePath(rel: string): string {
    const full = resolve(this.root, rel);
    const back = relative(this.root, full);
    if (back.startsWith("..") || isAbsolute(back)) {
      throw new Error(`Path is outside the reviewed folder: ${rel}`);
    }
    return full;
  }

  toRelative(full: string): string {
    return relative(this.root, full).split(sep).join("/");
  }

  annotationFilePath(video: string): string {
    return this.resolvePath(video) + ".coanda.json";
  }

  frameDir(video: string): string {
    return this.resolvePath(video) + ".coanda";
  }

  read(video: string): AnnotationFile {
    const file = this.annotationFilePath(video);
    if (!existsSync(file)) return { annotations: [] };
    return JSON.parse(readFileSync(file, "utf8")) as AnnotationFile;
  }

  write(video: string, data: AnnotationFile): void {
    writeFileSync(this.annotationFilePath(video), JSON.stringify(data, null, 2) + "\n");
  }

  update(video: string, change: (data: AnnotationFile) => void): AnnotationFile {
    const data = this.read(video);
    change(data);
    this.write(video, data);
    return data;
  }

  /** Saves a PNG of the annotated frame and returns its path relative to the root. */
  saveFrame(video: string, id: number, png: Buffer): string {
    const dir = this.frameDir(video);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.png`);
    writeFileSync(file, png);
    return this.toRelative(file);
  }

  tree(): TreeNode[] {
    return this.scan(this.root);
  }

  private scan(dir: string): TreeNode[] {
    const folders: TreeNode[] = [];
    const videos: TreeNode[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith(".coanda")) continue;
        const children = this.scan(full);
        folders.push({
          name: entry.name,
          path: this.toRelative(full),
          kind: "folder",
          children,
          ...(existsSync(join(full, PROJECT_FILE)) ? { project: true } : {}),
        });
      } else if (isVideoFile(entry.name)) {
        const path = this.toRelative(full);
        const { annotations } = this.read(path);
        const count = (test: (a: Annotation) => boolean) => annotations.filter(test).length;
        videos.push({
          name: entry.name,
          path,
          kind: "video",
          unresolved: count((a) => a.status !== "resolved"),
          open: count((a) => a.status === "open"),
          sent: count((a) => a.status === "sent"),
          mtime: statSync(full).mtimeMs,
        });
      }
    }
    const byName = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name);
    return [...folders.sort(byName), ...videos.sort(byName)];
  }

  /** The video project a video belongs to: the nearest folder above it holding
   * video-project.json, as a relative path ("" for the root). Null when there is none. */
  projectFor(video: string): string | null {
    return this.projectAbove(dirname(this.resolvePath(video)));
  }

  /** The video project a folder is in: itself or the nearest folder above it holding
   * video-project.json, as a relative path ("" for the root). Null when there is none. */
  projectForFolder(folder: string): string | null {
    return this.projectAbove(this.resolvePath(folder));
  }

  /** Makes a folder a video project by writing an empty video-project.json in it. */
  makeProject(folder: string): void {
    const file = join(this.resolvePath(folder), PROJECT_FILE);
    if (!existsSync(file)) writeFileSync(file, "{}\n");
  }

  private projectAbove(start: string): string | null {
    let dir = start;
    for (;;) {
      if (existsSync(join(dir, PROJECT_FILE))) return this.toRelative(dir);
      if (dir === this.root || dirname(dir) === dir) return null;
      dir = dirname(dir);
    }
  }

  /** Subtitle files beside a video: same name, optional language, .srt or .vtt. */
  subtitlesFor(video: string): string[] {
    const full = this.resolvePath(video);
    const dir = dirname(full);
    const name = basename(full).replace(/\.[^.]+$/, "");
    return readdirSync(dir)
      .filter((f) => f.startsWith(name + ".") && /\.(srt|vtt)$/i.test(f))
      .sort()
      .map((f) => this.toRelative(join(dir, f)));
  }

  /** Every video under the root that has annotations, with its annotation file. */
  allAnnotated(): ({ video: string } & AnnotationFile)[] {
    const out: ({ video: string } & AnnotationFile)[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.kind === "folder") walk(n.children ?? []);
        else {
          const data = this.read(n.path);
          if (data.annotations.length) out.push({ video: n.path, ...data });
        }
      }
    };
    walk(this.tree());
    return out;
  }

  rootName(): string {
    return basename(this.root);
  }
}
