import type {
  Annotation,
  ServerEvent,
  ServerInfo,
  AgentState,
  ClaudeAuth,
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

export interface NewAnnotation {
  kind: "pin" | "arrow";
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  t: number;
  text: string;
  frameDataUrl?: string;
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
  reply: (video: string, id: number, text: string) =>
    post<Annotation[]>(`/api/annotations/${id}/reply?${q(video)}`, { text }),
  /** With a project, its open annotations go to the project's Claude session. */
  send: (project?: string | null) =>
    post<{ sent: number }>(
      project == null ? "/api/send" : `/api/send?project=${encodeURIComponent(project)}`,
    ),
  projectForFolder: (folder: string) =>
    request<{ project: string | null }>(`/api/project?folder=${encodeURIComponent(folder)}`),
  makeProject: (folder: string) =>
    post<{ project: string }>(`/api/make-project?folder=${encodeURIComponent(folder)}`),
  agent: (project: string) => request<AgentState>(`/api/agent?${p(project)}`),
  agentMessage: (project: string, text: string) =>
    post<AgentState>(`/api/agent/message?${p(project)}`, { text }),
  agentStop: (project: string) => post<AgentState>(`/api/agent/stop?${p(project)}`),
  claudeAuth: () => request<ClaudeAuth>("/api/claude-auth"),
  claudeLogin: () => post<{ started: boolean }>("/api/claude-login"),
  settings: () => request<{ elevenLabsKey: boolean }>("/api/settings"),
  saveElevenLabsKey: (key: string) =>
    post<{ elevenLabsKey: boolean }>("/api/settings", { elevenLabsKey: key }),
  videoInfo: (video: string) => request<VideoInfo>(`/api/video?${q(video)}`),
  setVoiceReady: (video: string, voiceReady: boolean) =>
    post<{ voiceReady: boolean }>(`/api/video?${q(video)}`, { voiceReady }),
};

export function mediaUrl(path: string, version?: number): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `/media/${encoded}${version ? `?v=${Math.round(version)}` : ""}`;
}

export function subtitleUrl(path: string): string {
  return `/subtitles/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function subscribe(onEvent: (e: ServerEvent) => void): () => void {
  const source = new EventSource("/api/events");
  source.onmessage = (m) => onEvent(JSON.parse(m.data as string) as ServerEvent);
  return () => source.close();
}
