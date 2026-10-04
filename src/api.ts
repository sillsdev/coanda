import type {
  AgentQuestion,
  Annotation,
  DocText,
  PlanningStep,
  TextQuote,
  ServerEvent,
  ServerInfo,
  AgentState,
  ClaudeAuth,
  ProjectSettings,
  ServerStatus,
  TreeNode,
  VideoInfo,
} from "../shared/types.ts";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json()) as T | { error: string };
  if (!res.ok) throw new Error((body as { error: string }).error ?? res.statusText);
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const q = (video: string) => `video=${encodeURIComponent(video)}`;
const p = (project: string) => `project=${encodeURIComponent(project)}`;

/** A saved API key, as its first 13 characters and its length. */
export interface KeyStart {
  start: string;
  length: number;
}

/** The saved API keys; null where there is none. */
export interface SavedKeys {
  elevenLabsKey: KeyStart | null;
  openRouterKey: KeyStart | null;
}

export interface NewAnnotation {
  kind: "pin" | "arrow" | "text";
  quote?: TextQuote;
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  t: number;
  text: string;
  frameDataUrl?: string;
  /** Pasted images, as data URLs. */
  images?: string[];
}

/** A change to the note's text (or, with `message`, to one of the reviewer's replies). */
export interface NoteEdit {
  message?: number;
  text: string;
  /** Saved images to keep. */
  keep: string[];
  /** Newly pasted images, as data URLs. */
  images: string[];
}

export const api = {
  info: () => request<ServerInfo>("/api/info"),
  status: () => request<ServerStatus>("/api/status"),
  setRoot: (path: string) => post<ServerInfo>("/api/root", { path }),
  /** Opens the OS folder chooser on the server's machine and switches to the chosen folder. */
  pickFolder: () => post<{ picked: boolean; info: ServerInfo }>("/api/pick-folder"),
  tree: () => request<TreeNode[]>("/api/tree"),
  annotations: (video: string) => request<Annotation[]>(`/api/annotations?${q(video)}`),
  create: (video: string, a: NewAnnotation) => post<Annotation>(`/api/annotations?${q(video)}`, a),
  resolve: (video: string, id: number) =>
    post<Annotation[]>(`/api/annotations/${id}/resolve?${q(video)}`),
  reopen: (video: string, id: number) =>
    post<Annotation[]>(`/api/annotations/${id}/reopen?${q(video)}`),
  reply: (video: string, id: number, text: string, images: string[] = []) =>
    post<Annotation[]>(`/api/annotations/${id}/reply?${q(video)}`, { text, images }),
  edit: (video: string, id: number, change: NoteEdit) =>
    post<Annotation[]>(`/api/annotations/${id}/edit?${q(video)}`, change),
  remove: (video: string, id: number) =>
    post<Annotation[]>(`/api/annotations/${id}/delete?${q(video)}`),
  /** With a project, its open annotations go to the project's Claude session. */
  send: (project?: string | null, planApproval = false) =>
    post<{ sent: number }>(
      project == null ? "/api/send" : `/api/send?project=${encodeURIComponent(project)}`,
      { planApproval },
    ),
  /** Asks the project's session to record the video's missing voice, plan first. */
  voicePass: (project: string, video: string) =>
    post<AgentState>(`/api/agent/voice-pass?${p(project)}&${q(video)}`),
  projectForFolder: (folder: string) =>
    request<{ project: string | null }>(`/api/project?folder=${encodeURIComponent(folder)}`),
  makeProject: (folder: string) =>
    post<{ project: string }>(`/api/make-project?folder=${encodeURIComponent(folder)}`),
  agent: (project: string) => request<AgentState>(`/api/agent?${p(project)}`),
  agentMessage: (project: string, text: string, images: string[] = []) =>
    post<AgentState>(`/api/agent/message?${p(project)}`, { text, images }),
  doc: (doc: string) => request<DocText>(`/api/doc?${q(doc)}`),
  questions: (project: string) => request<AgentQuestion[]>(`/api/questions?${p(project)}`),
  /** Answers one of Claude's questions; an empty answer takes the answer back. */
  answer: (project: string, id: number, text: string) =>
    post<AgentQuestion[]>(`/api/questions/${id}/answer?${p(project)}`, { text }),
  planning: (project: string) => request<PlanningStep[]>(`/api/planning?${p(project)}`),
  /** Starts a planning document from its template, and has Claude begin on it with the
   * reviewer. */
  startPlanning: (project: string, step: string) =>
    post<{ path: string }>(`/api/planning/start?${p(project)}&step=${encodeURIComponent(step)}`),
  /** When the draft video was asked for, or null. */
  draft: (project: string) =>
    request<{ requestedAt: string | null }>(`/api/planning/draft?${p(project)}`),
  /** Asks Claude to build the draft video from the approved script. */
  makeDraft: (project: string) =>
    post<{ requestedAt: string | null }>(`/api/planning/draft?${p(project)}`),
  approve: (doc: string, approved: boolean) =>
    post<{ ok: true }>(`/api/approve?${q(doc)}`, { approved }),
  /** Saves a document; refused if it changed on disk since `baseMtime`. */
  saveDoc: (doc: string, text: string, baseMtime: number) =>
    post<DocText>(`/api/doc?${q(doc)}`, { text, baseMtime }),
  /** Saves an image pasted into a document beside it; returns its path relative to the
   * document. */
  docImage: (doc: string, image: string) =>
    post<{ path: string }>(`/api/doc/image?${q(doc)}`, { image }),
  agentStop: (project: string) => post<AgentState>(`/api/agent/stop?${p(project)}`),
  agentCompact: (project: string) => post<AgentState>(`/api/agent/compact?${p(project)}`),
  projectSettings: (project: string) =>
    request<ProjectSettings>(`/api/project-settings?${p(project)}`),
  setProjectSettings: (project: string, change: { model?: string; effort?: string }) =>
    post<ProjectSettings>(`/api/project-settings?${p(project)}`, change),
  /** Opens the OS folder chooser and sets the project's Bloom worktree. */
  chooseBloom: (project: string) =>
    post<{ bloom: string | null }>(`/api/project-bloom?${p(project)}`),
  claudeAuth: () => request<ClaudeAuth>("/api/claude-auth"),
  /** Shows a path in the reviewed folder, selected, in File Explorer. */
  reveal: (path: string) => post<{ path: string }>("/api/reveal", { path }),
  /** Opens a file or folder with its default app; a relative path is tried against the
   * reviewed folder, then the project's folders. */
  openPath: (path: string, project?: string | null) =>
    post<{ path: string }>(project == null ? "/api/open" : `/api/open?${p(project)}`, { path }),
  claudeLogin: () => post<{ started: boolean }>("/api/claude-login"),
  /** What's left on the OpenRouter account, in dollars. */
  openRouterCredits: () =>
    request<{ total: number; used: number; remaining: number }>("/api/openrouter-credits"),
  /** Which API keys are saved. */
  settings: () => request<SavedKeys>("/api/settings"),
  saveKey: (which: keyof SavedKeys, key: string) =>
    post<SavedKeys>("/api/settings", { [which]: key }),
  videoInfo: (video: string) => request<VideoInfo>(`/api/video?${q(video)}`),
};

export function mediaUrl(path: string, version?: number): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `/media/${encoded}${version ? `?v=${Math.round(version)}` : ""}`;
}

export function subtitleUrl(path: string): string {
  return `/subtitles/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Listens to the server's events. `onConnect` runs each time the connection opens, including
 * after the server restarts, when everything shown may be out of date.
 */
export function subscribe(onEvent: (e: ServerEvent) => void, onConnect?: () => void): () => void {
  const source = new EventSource("/api/events");
  source.onmessage = (m) => onEvent(JSON.parse(m.data as string) as ServerEvent);
  source.onopen = () => onConnect?.();
  return () => source.close();
}
