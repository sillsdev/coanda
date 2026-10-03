import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Annotation, ServerInfo, ServerStatus, TreeNode } from "../shared/types.ts";
import { api, mediaUrl, subscribe } from "./api.ts";
import { AnnotationList } from "./components/AnnotationList.tsx";
import { Header } from "./components/Header.tsx";
import { Player, type PlayerHandle } from "./components/Player.tsx";
import { VideoTree } from "./components/VideoTree.tsx";
import { findNode } from "./format.ts";
import "./App.css";

function videoFromHash(): string | undefined {
  const v = new URLSearchParams(location.hash.slice(1)).get("video");
  return v ?? undefined;
}

function sumVideos(nodes: TreeNode[], pick: (n: TreeNode) => number): number {
  return nodes.reduce(
    (sum, n) => sum + (n.kind === "video" ? pick(n) : sumVideos(n.children ?? [], pick)),
    0,
  );
}

function App() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [video, setVideo] = useState<string | undefined>(videoFromHash);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [renderedAt, setRenderedAt] = useState<number | null>(null);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const playerRef = useRef<PlayerHandle>(null);
  const videoRef = useRef(video);
  useEffect(() => {
    videoRef.current = video;
  }, [video]);

  const loadAnnotations = useCallback(async (path: string) => {
    const list = await api.annotations(path);
    if (videoRef.current === path) setAnnotations(list);
  }, []);

  useEffect(() => {
    api.info().then(setInfo, (e: Error) => setError(e.message));
    void api.status().then(setStatus);
    api.tree().then(setTree, (e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    return subscribe((e) => {
      if (e.type === "tree") void api.tree().then(setTree);
      if (e.type === "status") void api.status().then(setStatus);
      if (e.type === "annotations" && e.video === videoRef.current) void loadAnnotations(e.video);
      if (e.type === "video-changed" && e.video === videoRef.current) setRenderedAt(Date.now());
    });
  }, [loadAnnotations]);

  useEffect(() => {
    if (!video) return;
    history.replaceState(null, "", `#video=${encodeURIComponent(video)}`);
    void loadAnnotations(video);
  }, [video, loadAnnotations]);

  const chooseVideo = (path: string) => {
    if (path === video) return;
    setAnnotations([]);
    setActiveId(null);
    setRenderedAt(null);
    setVideo(path);
  };

  const node = video ? findNode(tree, video) : undefined;
  const openTotal = sumVideos(tree, (n) => n.open ?? 0);
  const sentTotal = sumVideos(tree, (n) => n.sent ?? 0);
  const openHere = annotations.filter((a) => a.status === "open").length;

  const reviewers = useMemo(() => {
    const names = new Set<string>();
    if (info) names.add(info.user);
    for (const a of annotations) names.add(a.author);
    return [...names];
  }, [info, annotations]);

  const select = (a: Annotation) => {
    setActiveId(a.id);
    playerRef.current?.seek(a.t);
  };

  const run = (p: Promise<unknown>) => p.catch((e: Error) => setError(e.message));

  if (error && !info)
    return <div className="fatal">Could not reach the Coanda server: {error}</div>;
  if (!info) return null;

  return (
    <div className="app">
      <Header rootName={info.rootName} video={video} reviewers={reviewers} />
      <div className="columns">
        <VideoTree
          rootName={info.rootName}
          rootPath={info.root}
          tree={tree}
          selected={video}
          onSelect={chooseVideo}
        />
        {video && node ? (
          <Player
            key={video}
            video={video}
            src={mediaUrl(video, node.mtime)}
            annotations={annotations}
            activeId={activeId}
            showResolved={showResolved}
            me={info.user}
            ref={playerRef}
            renderedAt={renderedAt}
            onSelect={select}
            onDeselect={() => setActiveId(null)}
            onCreate={async (draft) => {
              const created = await api.create(video, draft);
              setAnnotations((list) => [...list.filter((a) => a.id !== created.id), created]);
              setActiveId(created.id);
            }}
          />
        ) : (
          <main className="player empty">
            {tree.length ? "Choose a video on the left." : `No videos found in ${info.root}`}
          </main>
        )}
        <AnnotationList
          annotations={annotations}
          activeId={activeId}
          showResolved={showResolved}
          onToggleResolved={() => setShowResolved((s) => !s)}
          onSelect={select}
          onResolve={(a) => void run(api.resolve(video!, a.id).then(setAnnotations))}
          onReopen={(a) => void run(api.reopen(video!, a.id).then(setAnnotations))}
          onReply={async (a, text) => {
            await run(api.reply(video!, a.id, text).then(setAnnotations));
          }}
          openTotal={openTotal}
          openElsewhere={openTotal - openHere}
          sentTotal={sentTotal}
          sendNote={
            status?.undelivered
              ? "Claude Code isn't listening right now. It will get these the next time it checks."
              : null
          }
          onSend={() =>
            void run(
              api.send().then(() => {
                if (video) void loadAnnotations(video);
                void api.tree().then(setTree);
              }),
            )
          }
        />
      </div>
      {error && (
        <div className="toast" onClick={() => setError(null)}>
          {error}
        </div>
      )}
    </div>
  );
}

export default App;
