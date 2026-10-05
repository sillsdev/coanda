// Reads the reviewed folder and the annotation files kept next to each video.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  Annotation,
  AnnotationFile,
  DocText,
  PlanningStep,
  AgentQuestion,
  Timeline,
  TreeNode,
  UnvoicedLine,
} from "../shared/types.ts";
import { PLANNING_STEPS } from "../shared/types.ts";

export const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov", ".m4v", ".ogv"];

/** Files Coanda opens as documents, to read, edit and comment on. */
export function isDocument(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

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

  /** A file and Coanda's own files beside it: its annotations and saved frames. */
  withSidecars(path: string): string[] {
    return [this.resolvePath(path), this.annotationFilePath(path), this.frameDir(path)].filter(
      (f) => existsSync(f),
    );
  }

  /** Renames a file, and Coanda's files beside it, within its folder. Returns its new path. */
  rename(path: string, name: string): string {
    name = name.trim();
    if (!name || /[\\/:*?"<>|]/.test(name) || name === "." || name === "..") {
      throw new Error(`Not a usable file name: ${name}`);
    }
    const full = this.resolvePath(path);
    const next = this.toRelative(join(dirname(full), name));
    if (next === path) return path;
    if (existsSync(this.resolvePath(next))) throw new Error(`${name} already exists`);
    renameSync(full, this.resolvePath(next));
    for (const [from, to] of [
      [this.annotationFilePath(path), this.annotationFilePath(next)],
      [this.frameDir(path), this.frameDir(next)],
    ]) {
      if (existsSync(from) && !existsSync(to)) renameSync(from, to);
    }
    return next;
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

  /** Saves an image the reviewer pasted into a note and returns its path relative to the root. */
  saveImage(video: string, image: Buffer, ext: string): string {
    const dir = this.frameDir(video);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `pasted-${stampName()}.${ext}`);
    writeFileSync(file, image);
    return this.toRelative(file);
  }

  readDoc(doc: string): DocText | null {
    const full = this.resolvePath(doc);
    if (!existsSync(full)) return null;
    return { text: readFileSync(full, "utf8"), mtime: statSync(full).mtimeMs };
  }

  /**
   * Saves a document's text, unless it changed on disk since `baseMtime`, when it was read: then
   * returns null and leaves the file alone.
   */
  writeDoc(doc: string, text: string, baseMtime: number): DocText | null {
    const full = this.resolvePath(doc);
    if (existsSync(full) && Math.abs(statSync(full).mtimeMs - baseMtime) > 1) return null;
    writeFileSync(full, text);
    return { text, mtime: statSync(full).mtimeMs };
  }

  /**
   * Saves an image pasted into a document, in an `images` folder beside it, where it's kept
   * with the document. Returns its path relative to the document, as the document links to it.
   */
  saveDocImage(doc: string, image: Buffer, ext: string): string {
    const full = this.resolvePath(doc);
    const dir = join(dirname(full), "images");
    mkdirSync(dir, { recursive: true });
    const name = `${basename(full).replace(/\.[^.]+$/, "")}-${stampName()}.${ext}`;
    writeFileSync(join(dir, name), image);
    return `images/${name}`;
  }

  /** Saves an image pasted into a project's chat, in the project's `.coanda/chat` folder. */
  saveChatImage(project: string, image: Buffer, ext: string): string {
    const dir = join(this.resolvePath(project), ".coanda", "chat");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `pasted-${stampName()}.${ext}`);
    writeFileSync(file, image);
    return this.toRelative(file);
  }

  /** Deletes a file Coanda saved beside a video, such as a frame or a pasted image. */
  removeSaved(video: string, rel: string): void {
    const full = this.resolvePath(rel);
    if (dirname(full) !== this.frameDir(video)) return;
    rmSync(full, { force: true });
  }

  tree(): TreeNode[] {
    return this.scan(this.root);
  }

  private scan(dir: string): TreeNode[] {
    const folders: TreeNode[] = [];
    const files: TreeNode[] = [];
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
        files.push({
          name: entry.name,
          path,
          kind: "video",
          unresolved: count((a) => a.status !== "resolved"),
          open: count((a) => a.status === "open"),
          sent: count((a) => a.status === "sent"),
          mtime: statSync(full).mtimeMs,
        });
      } else if (!entry.name.endsWith(".coanda.json")) {
        let mtime: number | undefined;
        try {
          mtime = statSync(full).mtimeMs;
        } catch {
          // Gone or locked since it was listed; show it without a date.
        }
        const path = this.toRelative(full);
        const node: TreeNode = { name: entry.name, path, kind: "file", mtime };
        if (isDocument(entry.name) && existsSync(full + ".coanda.json")) {
          const { annotations, approved } = this.read(path);
          if (approved && mtime !== undefined && Math.abs(mtime - approved.mtime) <= 1) {
            node.approved = true;
          }
          node.unresolved = annotations.filter((a) => a.status !== "resolved").length;
          node.open = annotations.filter((a) => a.status === "open").length;
          node.sent = annotations.filter((a) => a.status === "sent").length;
        }
        files.push(node);
      }
    }
    const byName = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name);
    // In a project, its planning documents come first, in the order they're written.
    if (existsSync(join(dir, PROJECT_FILE))) {
      const planned: TreeNode[] = [];
      PLANNING_STEPS.forEach((step, i) => {
        const at = files.findIndex((f) => f.kind === "file" && f.name === step.file);
        if (at >= 0) planned.push({ ...files.splice(at, 1)[0], step: i + 1 });
      });
      return [...planned, ...folders.sort(byName), ...files.sort(byName)];
    }
    return [...folders.sort(byName), ...files.sort(byName)];
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
  /** The project's planning documents and how far each has got. */
  /** `templates` holds each step's template, by step key. */
  planningSteps(project: string, templates: Record<string, string>): PlanningStep[] {
    const unify = (text: string) => text.replace(/\r\n/g, "\n").trim();
    return PLANNING_STEPS.map((step) => {
      const path = project ? `${project}/${step.file}` : step.file;
      const full = this.resolvePath(path);
      const exists = existsSync(full);
      const data: AnnotationFile = exists ? this.read(path) : { annotations: [] };
      const approved = data.approved;
      const started =
        exists &&
        (data.started !== undefined ||
          unify(readFileSync(full, "utf8")) !== unify(templates[step.key] ?? ""));
      return {
        key: step.key,
        title: step.title,
        path,
        exists,
        started,
        ...(approved ? { approved: { by: approved.by, at: approved.at } } : {}),
        changedSinceApproval:
          exists && approved !== undefined && Math.abs(statSync(full).mtimeMs - approved.mtime) > 1,
        unresolved: data.annotations.filter((a) => a.status !== "resolved").length,
      };
    });
  }

  /** Starts a planning document from Coanda's template, unless it's already there. */
  startPlanningStep(project: string, key: string, template: string): string {
    const step = PLANNING_STEPS.find((s) => s.key === key);
    if (!step) throw new Error(`No planning step "${key}"`);
    const path = project ? `${project}/${step.file}` : step.file;
    const full = this.resolvePath(path);
    if (!existsSync(full)) writeFileSync(full, template);
    this.update(path, (data) => {
      data.started ??= new Date().toISOString();
    });
    return path;
  }

  /** When the reviewer asked for the project's draft video, or null. */
  draftRequested(project: string): string | null {
    try {
      const file = join(this.resolvePath(project), ".coanda", "planning.json");
      return (
        (JSON.parse(readFileSync(file, "utf8")) as { draftRequestedAt?: string })
          .draftRequestedAt ?? null
      );
    } catch {
      return null;
    }
  }

  requestDraft(project: string): void {
    const dir = join(this.resolvePath(project), ".coanda");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "planning.json"),
      JSON.stringify({ draftRequestedAt: new Date().toISOString() }, null, 2),
    );
  }

  /** Marks a document approved as it is now, or withdraws the approval. */
  approve(doc: string, by: string | null): void {
    const mtime = statSync(this.resolvePath(doc)).mtimeMs;
    this.update(doc, (data) => {
      if (by) data.approved = { by, at: new Date().toISOString(), mtime };
      else delete data.approved;
    });
  }

  /** Claude's questions to the reviewer in a project, kept in its `.coanda` folder. */
  questions(project: string): AgentQuestion[] {
    try {
      return JSON.parse(readFileSync(this.questionsFile(project), "utf8")) as AgentQuestion[];
    } catch {
      return [];
    }
  }

  updateQuestions(project: string, change: (list: AgentQuestion[]) => void): AgentQuestion[] {
    const list = this.questions(project);
    change(list);
    mkdirSync(dirname(this.questionsFile(project)), { recursive: true });
    writeFileSync(this.questionsFile(project), JSON.stringify(list, null, 2) + "\n");
    return list;
  }

  private questionsFile(project: string): string {
    return join(this.resolvePath(project), ".coanda", "questions.json");
  }

  /** Makes a folder a project, with its planning documents ready, each from its template. Any
   * that are already there are left as they are. */
  makeProject(folder: string, templates: Record<string, string>): void {
    const dir = this.resolvePath(folder);
    const file = join(dir, PROJECT_FILE);
    if (!existsSync(file)) writeFileSync(file, "{}\n");
    for (const step of PLANNING_STEPS) {
      const doc = join(dir, step.file);
      if (!existsSync(doc)) writeFileSync(doc, templates[step.key] ?? "");
    }
  }

  private projectAbove(start: string): string | null {
    let dir = start;
    for (;;) {
      if (existsSync(join(dir, PROJECT_FILE))) return this.toRelative(dir);
      if (dir === this.root || dirname(dir) === dir) return null;
      dir = dirname(dir);
    }
  }

  /** The pipeline's timeline for the current render: `<name>.timeline.json` beside the video. */
  timelinePath(video: string): string {
    const full = this.resolvePath(video);
    return join(dirname(full), basename(full).replace(/\.[^.]+$/, "") + ".timeline.json");
  }

  /** The timeline that the video's annotation times currently refer to. */
  timelineBasePath(video: string): string {
    return join(this.frameDir(video), "base.timeline.json");
  }

  /** Makes the current render's timeline the base, when there is one. */
  setTimelineBase(video: string): void {
    const now = this.timelinePath(video);
    if (!existsSync(now)) return;
    mkdirSync(this.frameDir(video), { recursive: true });
    copyFileSync(now, this.timelineBasePath(video));
  }

  /** The video a `<name>.voice.json` belongs to: the video beside it with the same name. */
  videoForReport(report: string): string | null {
    const stem = report.slice(0, -".voice.json".length);
    const ext = VIDEO_EXTENSIONS.find((e) => existsSync(this.resolvePath(stem + e)));
    return ext ? stem + ext : null;
  }

  /** The unvoiced lines in a `<name>.voice.json`, as `coanda voice` writes it. */
  readVoiceReport(report: string): { unvoiced: UnvoicedLine[] } | null {
    try {
      const data = JSON.parse(readFileSync(this.resolvePath(report), "utf8")) as {
        unvoiced?: UnvoicedLine[];
      };
      return Array.isArray(data?.unvoiced) ? { unvoiced: data.unvoiced } : null;
    } catch {
      return null;
    }
  }

  readTimeline(file: string): Timeline | null {
    try {
      const data = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Timeline;
      return Array.isArray(data?.anchors) ? data : null;
    } catch {
      return null;
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
        else if (n.kind === "video" || (n.kind === "file" && isDocument(n.name))) {
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

/** A name part unique to this moment, such as 20261003T182413132Z-p2ib. */
function stampName(): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}
