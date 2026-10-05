// The local server that the browser app talks to, and that `coanda wait` and
// `coanda reply` reach over the same port.
import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLANNING_STEPS } from "../shared/types.ts";
import type {
  Annotation,
  ServerEvent,
  ServerInfo,
  ServerStatus,
  ClaudeAuth,
  ReplyStatus,
  SentAnnotation,
  AgentQuestion,
  TextQuote,
  TimeSegment,
  TreeNode,
  VideoInfo,
} from "../shared/types.ts";
import { defaultConfigFile, loadConfig, saveConfig, withRoot } from "./config.ts";
import { AgentManager } from "./agents.ts";
import { credits as openRouterCredits } from "../toolkit/openrouter.ts";
import { osOpen, osReveal, osTrash } from "./osOpen.ts";
import { mapFromTimelines, mapTime } from "./timeMap.ts";
import { pickFolder } from "./pickFolder.ts";
import { bloomLaunch, ProjectSettingsStore } from "./projectSettings.ts";
import { isDocument, isVideoFile, PROJECT_FILE, Store } from "./store.ts";

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
/** Coanda's templates for planning documents. */
const TEMPLATES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "agent", "templates");

/** Each planning step's template, by step key, read afresh so edits to them apply at once. */
function planningTemplates(): Record<string, string> {
  return Object.fromEntries(
    PLANNING_STEPS.map((s) => [s.key, readFileSync(join(TEMPLATES, `${s.key}.md`), "utf8")]),
  );
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".woff2": "font/woff2",
};

function gitUserName(cwd: string): string {
  try {
    const name = execFileSync("git", ["config", "user.name"], { cwd, encoding: "utf8" }).trim();
    if (name) return name;
  } catch {
    // Not a git checkout, or git is missing: fall back to the OS account name.
  }
  return userInfo().username;
}

/** The Gravatar picture for git's user.email, which Gravatar answers with a 404 when the
 * address has none. */
function gitGravatar(cwd: string): string | undefined {
  try {
    const email = execFileSync("git", ["config", "user.email"], { cwd, encoding: "utf8" })
      .trim()
      .toLowerCase();
    if (!email) return undefined;
    const hash = createHash("sha256").update(email).digest("hex");
    return `https://gravatar.com/avatar/${hash}?s=80&d=404`;
  } catch {
    return undefined;
  }
}

/** The reviewer's name and, when Coanda knows their email, their picture. */
function whoAmI(cwd: string, user: string | undefined): Pick<ServerInfo, "user" | "avatars"> {
  if (user) return { user, avatars: {} };
  const name = gitUserName(cwd);
  const picture = gitGravatar(cwd);
  return { user: name, avatars: picture ? { [name]: picture } : {} };
}

export interface ServeOptions {
  /** Folder to review. When absent, the folder remembered from the last run is used. */
  root?: string;
  port: number;
  /** Where the remembered folder is kept. Defaults to ~/.coanda/config.json. */
  configFile?: string;
  /** Overrides the reviewer name taken from git config. */
  user?: string;
  /** Replaces the OS folder chooser; the tests use this. */
  pickFolder?: (initial?: string) => Promise<string | null>;
  /** How to run Claude Code, as command and leading arguments. Defaults to ["claude"]. */
  claudeCommand?: string[];
  /** Where Claude session IDs and transcripts are kept. Defaults to beside the config file. */
  sessionsFile?: string;
  /** Where the ElevenLabs API key is saved. Defaults to beside the config file. */
  elevenLabsKeyFile?: string;
}

export function serve(
  opts: ServeOptions,
): Promise<{ close: () => void; port: number; root: string | null }> {
  const configFile = opts.configFile ?? defaultConfigFile();
  let config = loadConfig(configFile);
  let store: Store | null = null;
  let watcher: FSWatcher | null = null;
  let agents: AgentManager | null = null;
  const claudeCommand = opts.claudeCommand ?? ["claude"];
  const keyFile = opts.elevenLabsKeyFile ?? join(dirname(configFile), "elevenlabs_key.txt");
  const openRouterKeyFile = join(dirname(configFile), "openrouter_key.txt");
  const projectSettings = new ProjectSettingsStore(join(dirname(configFile), "projects.json"));
  const info: ServerInfo = {
    root: null,
    rootName: "",
    user: opts.user ?? "",
    avatars: {},
    recent: [],
  };

  /** The current folder's store; an error when no folder has been chosen yet. */
  const need = (): Store => {
    if (!store) throw new HttpError(409, "No folder has been chosen yet");
    return store;
  };

  const sseClients = new Set<ServerResponse>();
  const pendingEvents = new Map<string, ServerEvent>();
  let flushTimer: NodeJS.Timeout | undefined;
  const emit = (event: ServerEvent) => {
    pendingEvents.set(JSON.stringify(event), event);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      for (const e of pendingEvents.values()) {
        const line = `data: ${JSON.stringify(e)}\n\n`;
        for (const c of sseClients) c.write(line);
      }
      pendingEvents.clear();
    }, 120);
  };

  // `coanda wait` requests parked until something is sent.
  const waiters = new Set<ServerResponse>();
  // Sent annotations already handed to a waiter, keyed "video#id". Kept in memory
  // only, so restarting the server hands any unanswered ones out again.
  const delivered = new Set<string>();

  const undelivered = (): SentAnnotation[] => {
    const out: SentAnnotation[] = [];
    if (!store) return out;
    for (const { video, annotations } of store.allAnnotated()) {
      for (const a of annotations) {
        if (a.status !== "sent" || delivered.has(`${video}#${a.id}`)) continue;
        out.push({
          ...a,
          video,
          videoFile: store!.resolvePath(video),
          frameFile: a.frame ? store!.resolvePath(a.frame) : undefined,
        });
      }
    }
    return out;
  };

  const releaseWaiters = () => {
    if (!waiters.size) return;
    const batch = undelivered();
    if (!batch.length) return;
    for (const a of batch) delivered.add(`${a.video}#${a.id}`);
    for (const w of waiters) json(w, 200, batch);
    waiters.clear();
    emit({ type: "status" });
  };

  /** Moves a video's notes from the timeline they're on to the new render's timeline. */
  const followTimelines = (video: string) => {
    const store = need();
    const base = store.readTimeline(store.timelineBasePath(video));
    const now = store.readTimeline(store.timelinePath(video));
    if (!base || !now) return;
    const segments = mapFromTimelines(base, now);
    if (segments.length) moveAnnotations(store, video, segments);
    store.setTimelineBase(video);
    emit({ type: "annotations", video });
  };

  // `coanda voice` writes `<name>.voice.json` last, after the video and its timeline. Each one
  // brings the render's unvoiced lines and moves the notes. The watcher reports a write several
  // times, so wait for it to settle.
  const voiceReportTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const onVoiceReport = (rel: string) => {
    clearTimeout(voiceReportTimers.get(rel));
    voiceReportTimers.set(
      rel,
      setTimeout(() => {
        voiceReportTimers.delete(rel);
        const store = need();
        const video = store.videoForReport(rel);
        const report = video && store.readVoiceReport(rel);
        if (!video || !report) return;
        store.update(video, (data) => {
          data.unvoiced = report.unvoiced;
        });
        followTimelines(video);
      }, 500),
    );
  };

  const onFileChange = (filename: string | null) => {
    if (!filename) return;
    const rel = filename.split("\\").join("/");
    if (rel.split("/").some((part) => part.startsWith("."))) return;
    if (rel.endsWith(".voice.json")) {
      onVoiceReport(rel);
    } else if (rel.endsWith(".coanda.json")) {
      emit({ type: "annotations", video: rel.slice(0, -".coanda.json".length) });
      emit({ type: "tree" });
    } else if (isDocument(rel)) {
      emit({ type: "doc-changed", path: rel });
      emit({ type: "tree" });
    } else if (isVideoFile(rel)) {
      emit({ type: "video-changed", video: rel });
      emit({ type: "tree" });
    } else if (!rel.includes(".coanda/")) {
      emit({ type: "tree" });
    }
  };

  const setRoot = (folder: string) => {
    const full = resolve(folder);
    if (!existsSync(full) || !statSync(full).isDirectory()) {
      throw new HttpError(400, `Not a folder: ${folder}`);
    }
    watcher?.close();
    store = new Store(full);
    watcher = watch(full, { recursive: true }, (_type, filename) => onFileChange(filename));
    delivered.clear();
    agents?.stopAll();
    agents = new AgentManager({
      cwd: full,
      command: claudeCommand,
      sessionsFile: opts.sessionsFile ?? join(dirname(configFile), "sessions.json"),
      onChange: (project) => {
        emit({ type: "agent", project });
        emit({ type: "tree" });
      },
      onReply: (video, id, text) => claudeReply(video, id, text),
      onTimeMap: (video, segments) => {
        moveAnnotations(need(), video, segments);
        need().setTimelineBase(video);
        emit({ type: "annotations", video });
      },
      onRenderedWithoutMap: (video) => followTimelines(video),
      onQuestions: (project, asked) => {
        need().updateQuestions(project, (list) => {
          let id = list.reduce((max, q) => Math.max(max, q.id), 0);
          for (const q of asked) {
            list.push({ id: ++id, ...q, askedAt: new Date().toISOString() });
          }
        });
        emit({ type: "questions", project });
      },
      onUnvoiced: (video, lines) => {
        need().update(video, (data) => {
          data.unvoiced = lines;
        });
        emit({ type: "annotations", video });
      },
      launch: (project) => {
        const dir = need().resolvePath(project);
        const { bloom, model, effort } = projectSettings.get(dir);
        const launch = bloom ? bloomLaunch(bloom) : {};
        launch.args = [
          ...(launch.args ?? []),
          ...(model ? ["--model", model] : []),
          ...(effort ? ["--effort", effort] : []),
        ];
        // The ElevenLabs key, for making voice-over, and the OpenRouter key, for images.
        if (existsSync(keyFile)) {
          launch.env = { ...launch.env, ELEVENLABS_API_KEY: readFileSync(keyFile, "utf8").trim() };
        }
        if (existsSync(openRouterKeyFile)) {
          launch.env = {
            ...launch.env,
            OPENROUTER_API_KEY: readFileSync(openRouterKeyFile, "utf8").trim(),
          };
        }
        return launch;
      },
    });
    config = withRoot(config, full);
    saveConfig(configFile, config);
    Object.assign(info, {
      root: full,
      rootName: store.rootName(),
      ...whoAmI(full, opts.user),
      recent: config.recent,
    });
    emit({ type: "root" });
    emit({ type: "status" });
  };

  const startRoot = opts.root ?? config.root;
  if (startRoot && existsSync(startRoot)) setRoot(startRoot);
  else Object.assign(info, { ...whoAmI(process.cwd(), opts.user), recent: config.recent });

  const findAnnotation = (video: string, id: number, change: (a: Annotation) => void) => {
    let found = false;
    need().update(video, (data) => {
      const a = data.annotations.find((x) => x.id === id);
      if (a) {
        change(a);
        found = true;
      }
    });
    if (!found) throw new HttpError(404, `No annotation ${id} on ${video}`);
    emit({ type: "annotations", video });
    emit({ type: "tree" });
  };

  const claudeReply = (
    video: string,
    id: number,
    reply: { text: string; status?: string; t?: number },
  ) =>
    findAnnotation(video, id, (a) => {
      const status = ["partial", "voice", "question"].includes(reply.status ?? "")
        ? (reply.status as ReplyStatus)
        : undefined;
      a.thread.push({
        who: "claude",
        text: reply.text.trim(),
        at: new Date().toISOString(),
        ...(status ? { replyStatus: status } : {}),
      });
      a.status = "replied";
      // A re-cut moved the note's moment: follow it into the new render.
      if (typeof reply.t === "number" && Number.isFinite(reply.t) && reply.t >= 0) {
        a.tOriginal ??= a.t;
        a.t = reply.t;
      }
    });

  /** The tree, with each project folder's Claude session status. */
  const treeWithAgents = (): TreeNode[] => {
    if (!store) return [];
    const mark = (nodes: TreeNode[]): TreeNode[] =>
      nodes.map((n) =>
        n.kind === "folder"
          ? {
              ...n,
              children: mark(n.children ?? []),
              ...(n.project ? { agentStatus: agents?.status(n.path) ?? "idle" } : {}),
            }
          : n,
      );
    return mark(store.tree());
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const video = url.searchParams.get("video") ?? "";
    const method = req.method ?? "GET";

    if (path === "/api/info") return json(res, 200, info);
    if (path === "/api/status") {
      const status: ServerStatus = { waiting: waiters.size > 0, undelivered: undelivered().length };
      return json(res, 200, status);
    }
    if (path === "/api/tree") return json(res, 200, treeWithAgents());

    if (path === "/api/project" && method === "GET") {
      const folder = url.searchParams.get("folder");
      const store = need();
      return json(res, 200, {
        project: folder !== null ? store.projectForFolder(folder) : store.projectFor(video),
      });
    }

    if (path === "/api/make-project" && method === "POST") {
      const folder = url.searchParams.get("folder") ?? "";
      need().makeProject(folder, planningTemplates());
      emit({ type: "tree" });
      return json(res, 200, { project: folder });
    }

    const project = url.searchParams.get("project");

    if (path === "/api/questions" && method === "GET") {
      if (project === null) throw new HttpError(400, "Give a project");
      return json(res, 200, need().questions(project));
    }

    const answer = path.match(/^\/api\/questions\/(\d+)\/answer$/);
    if (answer && method === "POST") {
      if (project === null) throw new HttpError(400, "Give a project");
      const body = (await readJson(req)) as { text?: string };
      const id = Number(answer[1]);
      let asked: AgentQuestion | undefined;
      const list = need().updateQuestions(project, (all) => {
        const q = all.find((x) => x.id === id);
        if (!q) throw new HttpError(404, `No question ${id}`);
        if (q.sent) throw new HttpError(400, "That answer has already gone to Claude");
        if (!body.text?.trim()) throw new HttpError(400, "An answer needs text");
        q.answer = { text: body.text.trim(), by: info.user, at: new Date().toISOString() };
        q.sent = true;
        asked = q;
      });
      // An answer goes to Claude at once. The chat shows it in the question's card.
      agents?.send(
        project,
        `[Coanda] ${asked!.answer!.by} answered your question "${asked!.text}": ${asked!.answer!.text}`,
        null,
      );
      emit({ type: "questions", project });
      return json(res, 200, list);
    }

    const forget = path.match(/^\/api\/questions\/(\d+)\/delete$/);
    if (forget && method === "POST") {
      if (project === null) throw new HttpError(400, "Give a project");
      const id = Number(forget[1]);
      const list = need().updateQuestions(project, (all) => {
        const at = all.findIndex((x) => x.id === id);
        if (at < 0) throw new HttpError(404, `No question ${id}`);
        all.splice(at, 1);
      });
      emit({ type: "questions", project });
      return json(res, 200, list);
    }

    if (path === "/api/planning" && method === "GET") {
      if (project === null) throw new HttpError(400, "Give a project");
      return json(res, 200, need().planningSteps(project, planningTemplates()));
    }

    if (path === "/api/planning/draft" && method === "GET") {
      if (project === null) throw new HttpError(400, "Give a project");
      return json(res, 200, { requestedAt: need().draftRequested(project) });
    }

    // After the script, the draft video: Claude builds it from the planning documents.
    if (path === "/api/planning/draft" && method === "POST") {
      if (project === null) throw new HttpError(400, "Give a project");
      need().requestDraft(project);
      if (agents) {
        agents.send(
          project,
          "[Coanda] The reviewer approved the script and asks for the draft video. Build it " +
            "from the script as your guidance says for the draft video.",
          "Make the draft video",
        );
      }
      return json(res, 200, { requestedAt: need().draftRequested(project) });
    }

    if (path === "/api/planning/start" && method === "POST") {
      if (project === null) throw new HttpError(400, "Give a project");
      const key = url.searchParams.get("step") ?? "";
      const template = readFileSync(join(TEMPLATES, `${key}.md`), "utf8");
      const doc = need().startPlanningStep(project, key, template);
      emit({ type: "tree" });
      // Claude takes it from there, as its guidance says for this step.
      if (agents) {
        const title = PLANNING_STEPS.find((s) => s.key === key)?.title ?? key;
        agents.send(
          project,
          `[Coanda] The reviewer has started the ${title.toLowerCase()}: ${doc}. Work on it with ` +
            `them as your guidance says for the ${title.toLowerCase()}.`,
          `Started the ${title.toLowerCase()}`,
        );
      }
      return json(res, 200, { path: doc });
    }

    if (path === "/api/approve" && method === "POST") {
      if (!isDocument(video)) throw new HttpError(400, `Not a document: ${video}`);
      const body = (await readJson(req)) as { approved?: boolean };
      const store = need();
      store.approve(video, body.approved ? info.user : null);
      emit({ type: "annotations", video });
      emit({ type: "tree" });
      // Claude hears about it, as it would from a colleague.
      const owner = store.projectFor(video);
      const step = PLANNING_STEPS.find((s) => video.endsWith(`/${s.file}`) || video === s.file);
      if (agents && owner !== null && step) {
        const what = step.title.toLowerCase();
        agents.send(
          owner,
          body.approved
            ? `[Coanda] The reviewer approved the ${what} (${video}), as it is now.`
            : `[Coanda] The reviewer withdrew their approval of the ${what} (${video}).`,
          body.approved ? `Approved the ${what}` : `Withdrew approval of the ${what}`,
        );
      }
      return json(res, 200, { ok: true });
    }

    if (path === "/api/agent" && method === "GET") {
      if (project === null || !agents) throw new HttpError(400, "Give a project");
      return json(res, 200, agents.state(project));
    }

    if (path === "/api/agent/message" && method === "POST") {
      if (project === null || !agents) throw new HttpError(400, "Give a project");
      const body = (await readJson(req)) as { text?: string; images?: string[] };
      const text = body.text?.trim() ?? "";
      const images = savePasted(body.images, (image, ext) =>
        need().saveChatImage(project, image, ext),
      );
      if (!text && !images.length) throw new HttpError(400, "A message needs text");
      // Claude reads the images from their paths, listed after the words.
      const withImages = images.length
        ? `${text}

[Images the reviewer pasted in: ${images.map((i) => need().resolvePath(i)).join(", ")}]`
        : text;
      agents.send(project, withImages, text, images);
      return json(res, 200, agents.state(project));
    }

    if (path === "/api/project-settings" && method === "GET") {
      if (project === null) throw new HttpError(400, "Give a project");
      return json(res, 200, projectSettings.get(need().resolvePath(project)));
    }

    if (path === "/api/project-settings" && method === "POST") {
      if (project === null || !agents) throw new HttpError(400, "Give a project");
      const dir = need().resolvePath(project);
      const body = (await readJson(req)) as { model?: string; effort?: string };
      const next = { ...projectSettings.get(dir) };
      // An empty string means Claude Code's default.
      if ("model" in body) next.model = body.model || undefined;
      if ("effort" in body) next.effort = body.effort || undefined;
      projectSettings.set(dir, next);
      // The next message starts the session again, resumed, with the new model or effort.
      agents.restartWhenIdle(project);
      emit({ type: "agent", project });
      return json(res, 200, next);
    }

    if (path === "/api/project-bloom" && method === "POST") {
      if (project === null || !agents) throw new HttpError(400, "Give a project");
      const dir = need().resolvePath(project);
      const body = (await readJson(req)) as { path?: string };
      const current = projectSettings.get(dir).bloom;
      const chosen = body.path ?? (await (opts.pickFolder ?? pickFolder)(current));
      if (!chosen) return json(res, 200, { bloom: current ?? null });
      const full = resolve(chosen);
      if (!existsSync(full) || !statSync(full).isDirectory()) {
        throw new HttpError(400, `Not a folder: ${chosen}`);
      }
      projectSettings.set(dir, { ...projectSettings.get(dir), bloom: full });
      // The next message starts the session with the new worktree.
      agents.restartWhenIdle(project);
      emit({ type: "agent", project });
      return json(res, 200, { bloom: full });
    }

    if (path === "/api/agent/compact" && method === "POST") {
      if (project === null || !agents) throw new HttpError(400, "Give a project");
      // Claude Code's own /compact, sent as a message, summarises the conversation so far.
      agents.send(project, "/compact", "Compact");
      return json(res, 200, agents.state(project));
    }

    if (path === "/api/agent/stop" && method === "POST") {
      if (project === null || !agents) throw new HttpError(400, "Give a project");
      agents.stop(project);
      return json(res, 200, agents.state(project));
    }

    if (path === "/api/rename" && method === "POST") {
      const body = (await readJson(req)) as { path?: string; name?: string };
      const store = need();
      if (!body.path || !existsSync(store.resolvePath(body.path))) {
        throw new HttpError(404, `Not found: ${body.path}`);
      }
      const renamed = store.rename(body.path, body.name ?? "");
      emit({ type: "tree" });
      return json(res, 200, { path: renamed });
    }

    if (path === "/api/delete" && method === "POST") {
      const body = (await readJson(req)) as { path?: string };
      const store = need();
      const files = body.path ? store.withSidecars(body.path) : [];
      if (!files.length) throw new HttpError(404, `Not found: ${body.path}`);
      for (const f of files) osTrash(f);
      emit({ type: "tree" });
      return json(res, 200, { ok: true });
    }

    if (path === "/api/reveal" && method === "POST") {
      const body = (await readJson(req)) as { path?: string };
      const full = need().resolvePath(body.path ?? "");
      if (!existsSync(full)) throw new HttpError(404, `Not found: ${body.path}`);
      osReveal(full);
      return json(res, 200, { path: full });
    }

    if (path === "/api/open" && method === "POST") {
      // Opens a path mentioned in a message. A relative path is tried against the reviewed
      // folder, the project folder, and the project's Bloom worktree, in that order.
      const body = (await readJson(req)) as { path?: string };
      const target = body.path?.trim();
      if (!target) throw new HttpError(400, "Give a path");
      const bases = [need().root];
      if (project !== null) {
        const dir = need().resolvePath(project);
        bases.push(dir);
        const { bloom } = projectSettings.get(dir);
        if (bloom) bases.push(bloom);
      }
      const candidates = isAbsolute(target) ? [target] : bases.map((b) => resolve(b, target));
      const found = candidates.find((c) => existsSync(c));
      if (!found) throw new HttpError(404, `Not found: ${target}`);
      return json(res, 200, { path: found, how: osOpen(found) });
    }

    if (path === "/api/claude-auth" && method === "GET") {
      return json(res, 200, await claudeAuth(claudeCommand));
    }

    if (path === "/api/claude-login" && method === "POST") {
      const [cmd, ...base] = claudeCommand;
      const child = spawn(cmd, [...base, "auth", "login"], { detached: true, stdio: "ignore" });
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        child.once("spawn", resolveSpawn);
        child.once("error", (err: NodeJS.ErrnoException) =>
          rejectSpawn(
            err.code === "ENOENT"
              ? new HttpError(500, "Claude Code is not installed")
              : new HttpError(500, err.message),
          ),
        );
      });
      child.unref();
      return json(res, 200, { started: true });
    }

    // Which keys are saved, as their first few characters, enough to tell keys apart, and their
    // length.
    const start = (file: string) => {
      if (!existsSync(file)) return null;
      const key = readFileSync(file, "utf8").trim();
      return { start: key.slice(0, 13), length: key.length };
    };
    const keys = () => ({
      elevenLabsKey: start(keyFile),
      openRouterKey: start(openRouterKeyFile),
    });

    if (path === "/api/openrouter-credits" && method === "GET") {
      if (!existsSync(openRouterKeyFile)) throw new HttpError(404, "No OpenRouter key");
      return json(
        res,
        200,
        await openRouterCredits(readFileSync(openRouterKeyFile, "utf8").trim()),
      );
    }

    if (path === "/api/settings" && method === "GET") {
      return json(res, 200, keys());
    }

    if (path === "/api/settings" && method === "POST") {
      const body = (await readJson(req)) as { elevenLabsKey?: string; openRouterKey?: string };
      for (const [value, file] of [
        [body.elevenLabsKey, keyFile],
        [body.openRouterKey, openRouterKeyFile],
      ] as const) {
        if (typeof value === "string" && value.trim()) {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, value.trim());
        }
      }
      return json(res, 200, keys());
    }

    if (path === "/api/pick-folder" && method === "POST") {
      const picked = await (opts.pickFolder ?? pickFolder)(info.root ?? undefined);
      if (picked) setRoot(picked);
      return json(res, 200, { picked: picked !== null, info });
    }

    if (path === "/api/root" && method === "POST") {
      const body = (await readJson(req)) as { path?: string };
      if (!body.path?.trim()) throw new HttpError(400, "Give a folder path");
      setRoot(body.path.trim());
      return json(res, 200, info);
    }

    if (path === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      res.on("close", () => sseClients.delete(res));
      return;
    }

    if (path === "/api/doc" && method === "GET") {
      if (!isDocument(video)) throw new HttpError(400, `Not a document: ${video}`);
      const doc = need().readDoc(video);
      if (!doc) throw new HttpError(404, `No document ${video}`);
      return json(res, 200, doc);
    }

    if (path === "/api/doc" && method === "POST") {
      if (!isDocument(video)) throw new HttpError(400, `Not a document: ${video}`);
      const body = (await readJson(req)) as { text?: string; baseMtime?: number };
      if (typeof body.text !== "string") throw new HttpError(400, "Give the document's text");
      const saved = need().writeDoc(video, body.text, Number(body.baseMtime));
      if (!saved) throw new HttpError(409, "The document changed on disk since it was opened");
      return json(res, 200, saved);
    }

    if (path === "/api/doc/image" && method === "POST") {
      if (!isDocument(video)) throw new HttpError(400, `Not a document: ${video}`);
      const body = (await readJson(req)) as { image?: string };
      const [saved] = savePasted([body.image], (image, ext) =>
        need().saveDocImage(video, image, ext),
      );
      if (!saved) throw new HttpError(400, "Not an image");
      return json(res, 200, { path: saved });
    }

    if (path === "/api/annotations" && method === "GET") {
      return json(res, 200, need().read(video).annotations);
    }

    if (path === "/api/annotations" && method === "POST") {
      const store = need();
      const body = (await readJson(req)) as Omit<Partial<Annotation>, "images"> & {
        frameDataUrl?: string;
        images?: string[];
      };
      if (!body.text?.trim() && !body.images?.length) {
        throw new HttpError(400, "An annotation needs text");
      }
      let created: Annotation | undefined;
      store.update(video, (data) => {
        const id = data.annotations.reduce((max, a) => Math.max(max, a.id), 0) + 1;
        const quote = body.kind === "text" ? textQuote(body.quote) : undefined;
        if (body.kind === "text" && !quote) throw new HttpError(400, "A comment needs a quote");
        created = {
          id,
          kind: body.kind === "arrow" ? "arrow" : quote ? "text" : "pin",
          ...(quote ? { quote } : {}),
          x: Number(body.x),
          y: Number(body.y),
          ...(body.kind === "arrow" ? { x2: Number(body.x2), y2: Number(body.y2) } : {}),
          t: Number(body.t),
          author: body.author || info.user,
          text: body.text?.trim() ?? "",
          status: "open",
          thread: [],
          createdAt: new Date().toISOString(),
        };
        const png = body.frameDataUrl?.match(/^data:image\/png;base64,(.+)$/)?.[1];
        if (png) created.frame = store.saveFrame(video, id, Buffer.from(png, "base64"));
        const images = savePasted(body.images, (image, ext) => store.saveImage(video, image, ext));
        if (images.length) created.images = images;
        data.annotations.push(created);
      });
      emit({ type: "annotations", video });
      emit({ type: "tree" });
      return json(res, 201, created);
    }

    const action = path.match(/^\/api\/annotations\/(\d+)\/(resolve|reopen|reply|edit|delete)$/);
    if (action && method === "POST") {
      const id = Number(action[1]);
      if (action[2] === "resolve") findAnnotation(video, id, (a) => (a.status = "resolved"));
      if (action[2] === "reopen") {
        findAnnotation(video, id, (a) => {
          const last = a.thread.at(-1);
          a.status = last?.who === "claude" ? "replied" : "open";
        });
      }
      if (action[2] === "reply") {
        const body = (await readJson(req)) as { text?: string; author?: string; images?: string[] };
        if (!body.text?.trim() && !body.images?.length) {
          throw new HttpError(400, "A reply needs text");
        }
        const images = savePasted(body.images, (image, ext) => need().saveImage(video, image, ext));
        findAnnotation(video, id, (a) => {
          a.thread.push({
            who: "user",
            author: body.author || info.user,
            text: body.text?.trim() ?? "",
            at: new Date().toISOString(),
            ...(images.length ? { images } : {}),
          });
          a.status = "open";
        });
      }
      if (action[2] === "edit") {
        // `message` picks a reply in the thread; without it, the note itself. `keep` lists the
        // images to keep, `images` adds pasted ones.
        const body = (await readJson(req)) as {
          message?: number;
          text?: string;
          keep?: string[];
          images?: string[];
        };
        const store = need();
        const added = savePasted(body.images, (image, ext) => store.saveImage(video, image, ext));
        const dropped: string[] = [];
        findAnnotation(video, id, (a) => {
          const target = body.message === undefined ? a : a.thread[body.message];
          if (!target || ("who" in target && target.who !== "user")) {
            throw new HttpError(400, "Only the reviewer's own text can be edited");
          }
          const kept = (target.images ?? []).filter((i) => body.keep?.includes(i) ?? true);
          dropped.push(...(target.images ?? []).filter((i) => !kept.includes(i)));
          const images = [...kept, ...added];
          const text = body.text?.trim() ?? target.text;
          if (!text && !images.length) throw new HttpError(400, "An annotation needs text");
          target.text = text;
          if (images.length) target.images = images;
          else delete target.images;
          target.editedAt = new Date().toISOString();
          // Already sent: the change goes with the next Send.
          if (a.status !== "open") a.status = "open";
        });
        for (const f of dropped) store.removeSaved(video, f);
      }
      if (action[2] === "delete") {
        const store = need();
        let removed: Annotation | undefined;
        store.update(video, (data) => {
          removed = data.annotations.find((x) => x.id === id);
          data.annotations = data.annotations.filter((x) => x.id !== id);
        });
        if (!removed) throw new HttpError(404, `No annotation ${id} on ${video}`);
        for (const f of [
          removed.frame,
          ...(removed.images ?? []),
          ...removed.thread.flatMap((m) => m.images ?? []),
        ]) {
          if (f) store.removeSaved(video, f);
        }
        emit({ type: "annotations", video });
        emit({ type: "tree" });
      }
      return json(res, 200, need().read(video).annotations);
    }

    if (path === "/api/video" && method === "GET") {
      const store = need();
      const result: VideoInfo = {
        unvoiced: store.read(video).unvoiced ?? [],
        subtitles: store.subtitlesFor(video),
      };
      return json(res, 200, result);
    }

    if (path === "/api/agent/voice-pass" && method === "POST") {
      if (project === null || !agents) throw new HttpError(400, "Give a project");
      if (!video) throw new HttpError(400, "Give a video");
      agents.send(
        project,
        `[Coanda] Voice pass for ${video}. Record every narration line of this video that has ` +
          "no matching recording, so the voice is complete and up to date. This costs money, " +
          "so plan first: list the lines, their count and the estimated cost, and wait for the " +
          "reviewer's go-ahead before generating anything. When the voice is recorded and the " +
          "video rebuilt, report its unvoiced lines (an empty list if none are left).",
        "Voice this video",
      );
      return json(res, 200, agents.state(project));
    }

    if (path.startsWith("/subtitles/")) {
      // Subtitles as WebVTT, which is what a <track> element reads. .srt differs only in its
      // header and in using a comma before the milliseconds.
      const file = need().resolvePath(decodeURIComponent(path.slice("/subtitles/".length)));
      if (!/\.(srt|vtt)$/i.test(file) || !existsSync(file)) throw new HttpError(404, "Not found");
      let text = readFileSync(file, "utf8").replace(/^﻿/, "");
      if (/\.srt$/i.test(file)) {
        text = "WEBVTT\n\n" + text.replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2");
      }
      res.writeHead(200, {
        "Content-Type": "text/vtt; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      return res.end(text);
    }

    if (path === "/api/send" && method === "POST") {
      const store = need();
      // With a project, the project's open annotations go to its Claude session. Without one,
      // every open annotation goes to whoever runs `coanda wait`.
      const inProject = (v: string) =>
        project === null || project === "" || v.startsWith(project + "/");
      let count = 0;
      for (const { video: v, annotations } of store.allAnnotated()) {
        if (!inProject(v) || !annotations.some((a) => a.status === "open")) continue;
        store.update(v, (data) => {
          for (const a of data.annotations) {
            if (a.status === "open") {
              a.status = "sent";
              delivered.delete(`${v}#${a.id}`);
              count++;
            }
          }
        });
        emit({ type: "annotations", video: v });
      }
      emit({ type: "tree" });
      if (project !== null && agents) {
        const batch = undelivered().filter((a) => inProject(a.video));
        for (const a of batch) delivered.add(`${a.video}#${a.id}`);
        // Answers to Claude's questions go with the notes.
        const answered: AgentQuestion[] = [];
        store.updateQuestions(project, (list) => {
          for (const q of list) {
            if (q.answer && !q.sent) {
              q.sent = true;
              answered.push(q);
            }
          }
        });
        count += answered.length;
        if (answered.length) emit({ type: "questions", project });
        if (batch.length || answered.length) {
          agents.send(
            project,
            "Annotations from the reviewer:\n\n" +
              JSON.stringify(
                {
                  ...projectSend(store, project, batch),
                  answers: answered.map((q) => ({
                    question: q.text,
                    answer: q.answer!.text,
                    by: q.answer!.by,
                  })),
                },
                null,
                2,
              ),
            describeSend(batch, answered),
          );
        }
      } else {
        releaseWaiters();
      }
      emit({ type: "status" });
      return json(res, 200, { sent: count });
    }

    if (path === "/api/wait" && method === "GET") {
      const ready = undelivered();
      if (ready.length) {
        for (const a of ready) delivered.add(`${a.video}#${a.id}`);
        emit({ type: "status" });
        return json(res, 200, ready);
      }
      waiters.add(res);
      emit({ type: "status" });
      // Answer with an empty list after a while, so clients (Node's fetch gives up after
      // 300 s) never wait on one request for too long; `coanda wait` just asks again.
      const hold = Math.min(Number(url.searchParams.get("hold") ?? 50), 240) * 1000;
      const timer = setTimeout(() => {
        if (waiters.delete(res)) json(res, 200, []);
      }, hold);
      // The response's close, not the request's: a GET's request side closes as soon
      // as its (empty) body has been read.
      res.on("close", () => {
        clearTimeout(timer);
        if (waiters.delete(res)) emit({ type: "status" });
      });
      return;
    }

    if (path === "/api/claude-reply" && method === "POST") {
      const body = (await readJson(req)) as { video?: string; id?: number; text?: string };
      if (!body.video || !body.id || !body.text?.trim()) {
        throw new HttpError(400, "A reply needs video, id and text");
      }
      claudeReply(body.video, Number(body.id), { text: body.text });
      return json(res, 200, { ok: true });
    }

    if (path === "/api/show" && method === "POST") {
      const store = need();
      const body = (await readJson(req)) as { video?: string };
      if (!body.video) throw new HttpError(400, "show needs a video");
      const full = store.resolvePath(body.video);
      if (!existsSync(full)) throw new HttpError(404, `No video at ${body.video}`);
      const video = store.toRelative(full);
      emit({ type: "show", video });
      return json(res, 200, { video });
    }

    if (path.startsWith("/media/")) {
      return sendFile(
        req,
        res,
        need().resolvePath(decodeURIComponent(path.slice("/media/".length))),
      );
    }

    if (path.startsWith("/api/")) throw new HttpError(404, `Unknown endpoint ${method} ${path}`);

    // The built app, with index.html for any other path.
    const asset = resolve(DIST, "." + decodeURIComponent(path));
    if (asset.startsWith(DIST) && existsSync(asset) && statSync(asset).isFile()) {
      return sendFile(req, res, asset);
    }
    const index = join(DIST, "index.html");
    if (!existsSync(index)) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end("The Coanda app has not been built. Run `vp build` in the Coanda folder.");
    }
    return sendFile(req, res, index);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent)
        json(res, status, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : opts.port;
      resolvePromise({
        port,
        root: info.root,
        close: () => {
          watcher?.close();
          agents?.stopAll();
          for (const c of sseClients) c.end();
          for (const w of waiters) w.end();
          server.close();
        },
      });
    });
  });
}

/** Asks Claude Code whether it is logged in. */
function claudeAuth(command: string[]): Promise<ClaudeAuth> {
  const [cmd, ...base] = command;
  return new Promise((resolvePromise) => {
    let out = "";
    try {
      const child = spawn(cmd, [...base, "auth", "status", "--json"], { windowsHide: true });
      child.stdout.on("data", (b: Buffer) => (out += b.toString()));
      child.on("error", (err: NodeJS.ErrnoException) =>
        resolvePromise({ installed: err.code !== "ENOENT", loggedIn: false }),
      );
      child.on("close", () => {
        try {
          const data = JSON.parse(out) as { loggedIn?: boolean; email?: string };
          resolvePromise({ installed: true, loggedIn: Boolean(data.loggedIn), email: data.email });
        } catch {
          resolvePromise({ installed: true, loggedIn: false });
        }
      });
    } catch {
      resolvePromise({ installed: true, loggedIn: false });
    }
  });
}

/**
 * What a project's session receives when the reviewer presses Send: the project's recipe once,
 * and for each video its switch, a copy of the render as reviewed, and its annotations.
 */
function projectSend(store: Store, project: string, batch: SentAnnotation[]) {
  const projectDir = store.resolvePath(project);
  let recipe: unknown = null;
  try {
    recipe = JSON.parse(readFileSync(join(projectDir, PROJECT_FILE), "utf8"));
  } catch {
    // An unreadable recipe is sent as null; the guidance tells the agent to write one.
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const files = [...new Set(batch.map((a) => a.video))];
  const thread = (a: SentAnnotation) =>
    a.thread.map((m) =>
      m.images ? { ...m, images: m.images.map((i) => store.resolvePath(i)) } : m,
    );
  const documents = files.filter(isDocument).map((doc) => ({
    document: doc,
    documentFile: store.resolvePath(doc),
    comments: batch
      .filter((a) => a.video === doc)
      .map((a) => ({
        id: a.id,
        quote: a.quote,
        text: a.text,
        author: a.author,
        ...(a.editedAt ? { editedAt: a.editedAt } : {}),
        thread: thread(a),
        ...(a.images ? { images: a.images.map((i) => store.resolvePath(i)) } : {}),
      })),
  }));
  const videos = files
    .filter((f) => !isDocument(f))
    .map((video) => {
      const videoFile = store.resolvePath(video);
      // Keep the render the notes refer to; the next render replaces the file at videoFile.
      const copyDir = store.frameDir(video);
      mkdirSync(copyDir, { recursive: true });
      const reviewedCopy = join(copyDir, `reviewed-${stamp}${extname(videoFile)}`);
      try {
        copyFileSync(videoFile, reviewedCopy);
      } catch {
        // The video is gone or unreadable; the agent still gets the notes.
      }
      // The pipeline's timeline for this render, if it writes one: kept with the copy, and made the
      // base that the next render's timeline is compared with.
      let reviewedTimeline: string | null = null;
      if (existsSync(store.timelinePath(video))) {
        reviewedTimeline = join(copyDir, `reviewed-${stamp}.timeline.json`);
        copyFileSync(store.timelinePath(video), reviewedTimeline);
        store.setTimelineBase(video);
      }
      store.update(video, (data) => {
        data.reviewed = {
          copy: reviewedCopy,
          ...(reviewedTimeline ? { timeline: reviewedTimeline } : {}),
        };
      });
      const notes = batch.filter((a) => a.video === video);
      return {
        video,
        videoFile,
        reviewedCopy: existsSync(reviewedCopy) ? reviewedCopy : null,
        reviewedTimeline,
        annotations: notes.map((a) => ({
          id: a.id,
          t: a.t,
          kind: a.kind,
          x: a.x,
          y: a.y,
          ...(a.kind === "arrow" ? { x2: a.x2, y2: a.y2 } : {}),
          text: a.text,
          author: a.author,
          ...(a.editedAt ? { editedAt: a.editedAt } : {}),
          thread: thread(a),
          frameFile: a.frameFile,
          ...(a.images ? { images: a.images.map((i) => store.resolvePath(i)) } : {}),
        })),
      };
    });
  return { recipe, videos, documents };
}

const PASTED_TYPES: Record<string, string> = {
  png: "png",
  jpeg: "jpg",
  gif: "gif",
  webp: "webp",
};

/** Saves pasted images, sent as data URLs, with `save`, and returns their paths. */
function savePasted(dataUrls: unknown, save: (image: Buffer, ext: string) => string): string[] {
  if (!Array.isArray(dataUrls)) return [];
  const out: string[] = [];
  for (const url of dataUrls) {
    const m = typeof url === "string" && url.match(/^data:image\/(png|jpeg|gif|webp);base64,(.+)$/);
    if (!m) continue;
    out.push(save(Buffer.from(m[2], "base64"), PASTED_TYPES[m[1]]));
  }
  return out;
}

/** A well-formed quote for a document comment, or undefined. */
function textQuote(raw: unknown): TextQuote | undefined {
  const q = raw as Partial<TextQuote> | undefined;
  if (typeof q?.exact !== "string" || !q.exact.trim()) return undefined;
  const str = (s: unknown) => (typeof s === "string" ? s : "");
  return { exact: q.exact, prefix: str(q.prefix), suffix: str(q.suffix) };
}

/**
 * What the chat shows of a send: each note as the conversation it is, the reviewer's words and
 * Claude's replies in order. Claude itself gets the full details as JSON.
 */
function describeSend(batch: SentAnnotation[], answered: AgentQuestion[]): string {
  const time = (t: number) =>
    `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const notes = batch.map((a) => {
    const file = a.video.split("/").pop();
    const head =
      a.kind === "text" && a.quote
        ? `${file}, comment ${a.id} on "${a.quote.exact}"`
        : `${file}, note ${a.id} at ${time(a.t)}`;
    const lines = [
      `${a.author}: ${a.text}`,
      ...a.thread.map(
        (m) => `${m.who === "claude" ? "Claude" : (m.author ?? "Reviewer")}: ${m.text}`,
      ),
    ];
    return [head, ...lines].join("\n");
  });
  const answers = answered.map((q) => `Claude: ${q.text}\n${q.answer!.by}: ${q.answer!.text}`);
  return [...answers, ...notes].join("\n\n");
}

/** Moves every annotation on a video along a time map; a note whose moment was cut is marked. */
function moveAnnotations(store: Store, video: string, segments: TimeSegment[]) {
  store.update(video, (data) => {
    for (const a of data.annotations) {
      const moved = mapTime(a.t, segments);
      if (moved.t === a.t && !moved.cut) continue;
      a.tOriginal ??= a.t;
      a.t = moved.t;
      if (moved.cut) a.cut = true;
    }
  });
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 30 * 1024 * 1024) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string) {
  if (!existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, "Not found");
  const size = statSync(file).size;
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Number(range[2]) : size - 1;
    if (start >= size || end >= size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Cache-Control": "no-cache",
    });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": size,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  });
  createReadStream(file).pipe(res);
}
