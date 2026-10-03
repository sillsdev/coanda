import type {
  Annotation,
  ServerEvent,
  ServerInfo,
  ServerStatus,
  TreeNode,
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
  tree: () => request<TreeNode[]>("/api/tree"),
  annotations: (video: string) => request<Annotation[]>(`/api/annotations?${q(video)}`),
  create: (video: string, a: NewAnnotation) => post<Annotation>(`/api/annotations?${q(video)}`, a),
  resolve: (video: string, id: number) =>
    post<Annotation[]>(`/api/annotations/${id}/resolve?${q(video)}`),
  reopen: (video: string, id: number) =>
    post<Annotation[]>(`/api/annotations/${id}/reopen?${q(video)}`),
  reply: (video: string, id: number, text: string) =>
    post<Annotation[]>(`/api/annotations/${id}/reply?${q(video)}`, { text }),
  send: () => post<{ sent: number }>("/api/send"),
};

export function mediaUrl(path: string, version?: number): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `/media/${encoded}${version ? `?v=${Math.round(version)}` : ""}`;
}

export function subscribe(onEvent: (e: ServerEvent) => void): () => void {
  const source = new EventSource("/api/events");
  source.onmessage = (m) => onEvent(JSON.parse(m.data as string) as ServerEvent);
  return () => source.close();
}
