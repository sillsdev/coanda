// The local server that the browser app talks to, and that `coanda wait` and
// `coanda reply` reach over the same port.
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, statSync, watch } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { userInfo } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Annotation,
  ServerEvent,
  ServerInfo,
  ServerStatus,
  SentAnnotation,
} from "../shared/types.ts";
import { isVideoFile, Store } from "./store.ts";

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
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

export interface ServeOptions {
  root: string;
  port: number;
  /** Overrides the reviewer name taken from git config. */
  user?: string;
}

export function serve(opts: ServeOptions): Promise<{ close: () => void; port: number }> {
  const store = new Store(opts.root);
  const info: ServerInfo = {
    root: store.root,
    rootName: store.rootName(),
    user: opts.user ?? gitUserName(store.root),
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
    for (const { video, annotations } of store.allAnnotated()) {
      for (const a of annotations) {
        if (a.status !== "sent" || delivered.has(`${video}#${a.id}`)) continue;
        out.push({
          ...a,
          video,
          videoFile: store.resolvePath(video),
          frameFile: a.frame ? store.resolvePath(a.frame) : undefined,
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

  const watcher = watch(store.root, { recursive: true }, (_type, filename) => {
    if (!filename) return;
    const rel = filename.split("\\").join("/");
    if (rel.split("/").some((part) => part.startsWith("."))) return;
    if (rel.endsWith(".coanda.json")) {
      emit({ type: "annotations", video: rel.slice(0, -".coanda.json".length) });
      emit({ type: "tree" });
    } else if (isVideoFile(rel)) {
      emit({ type: "video-changed", video: rel });
      emit({ type: "tree" });
    } else if (!rel.includes(".coanda/")) {
      emit({ type: "tree" });
    }
  });

  const findAnnotation = (video: string, id: number, change: (a: Annotation) => void) => {
    let found = false;
    store.update(video, (data) => {
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
    if (path === "/api/tree") return json(res, 200, store.tree());

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

    if (path === "/api/annotations" && method === "GET") {
      return json(res, 200, store.read(video).annotations);
    }

    if (path === "/api/annotations" && method === "POST") {
      const body = (await readJson(req)) as Partial<Annotation> & { frameDataUrl?: string };
      if (!body.text?.trim()) throw new HttpError(400, "An annotation needs text");
      let created: Annotation | undefined;
      store.update(video, (data) => {
        const id = data.annotations.reduce((max, a) => Math.max(max, a.id), 0) + 1;
        created = {
          id,
          kind: body.kind === "arrow" ? "arrow" : "pin",
          x: Number(body.x),
          y: Number(body.y),
          ...(body.kind === "arrow" ? { x2: Number(body.x2), y2: Number(body.y2) } : {}),
          t: Number(body.t),
          author: body.author || info.user,
          text: body.text!.trim(),
          status: "open",
          thread: [],
          createdAt: new Date().toISOString(),
        };
        const png = body.frameDataUrl?.match(/^data:image\/png;base64,(.+)$/)?.[1];
        if (png) created.frame = store.saveFrame(video, id, Buffer.from(png, "base64"));
        data.annotations.push(created);
      });
      emit({ type: "annotations", video });
      emit({ type: "tree" });
      return json(res, 201, created);
    }

    const action = path.match(/^\/api\/annotations\/(\d+)\/(resolve|reopen|reply)$/);
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
        const body = (await readJson(req)) as { text?: string; author?: string };
        if (!body.text?.trim()) throw new HttpError(400, "A reply needs text");
        findAnnotation(video, id, (a) => {
          a.thread.push({
            who: "user",
            author: body.author || info.user,
            text: body.text!.trim(),
            at: new Date().toISOString(),
          });
          a.status = "open";
        });
      }
      return json(res, 200, store.read(video).annotations);
    }

    if (path === "/api/send" && method === "POST") {
      let count = 0;
      for (const { video: v, annotations } of store.allAnnotated()) {
        if (!annotations.some((a) => a.status === "open")) continue;
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
      releaseWaiters();
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
      // The response's close, not the request's: a GET's request side closes as soon
      // as its (empty) body has been read.
      res.on("close", () => {
        if (waiters.delete(res)) emit({ type: "status" });
      });
      return;
    }

    if (path === "/api/claude-reply" && method === "POST") {
      const body = (await readJson(req)) as { video?: string; id?: number; text?: string };
      if (!body.video || !body.id || !body.text?.trim()) {
        throw new HttpError(400, "A reply needs video, id and text");
      }
      findAnnotation(body.video, Number(body.id), (a) => {
        a.thread.push({ who: "claude", text: body.text!.trim(), at: new Date().toISOString() });
        a.status = "replied";
      });
      return json(res, 200, { ok: true });
    }

    if (path.startsWith("/media/")) {
      return sendFile(
        req,
        res,
        store.resolvePath(decodeURIComponent(path.slice("/media/".length))),
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
        close: () => {
          watcher.close();
          for (const c of sseClients) c.end();
          for (const w of waiters) w.end();
          server.close();
        },
      });
    });
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
