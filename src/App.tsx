import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentState,
  Annotation,
  ClaudeAuth,
  ServerInfo,
  TreeNode,
  VideoInfo,
} from "../shared/types.ts";
import { api, mediaUrl, subscribe, subtitleUrl } from "./api.ts";
import { AgentPanel } from "./components/AgentPanel.tsx";
import { AnnotationList } from "./components/AnnotationList.tsx";
import { Header } from "./components/Header.tsx";
import { Player, type PlayerHandle } from "./components/Player.tsx";
import { Settings } from "./components/Settings.tsx";
import { Splitter } from "./components/Splitter.tsx";
import { VideoTree } from "./components/VideoTree.tsx";
import { findNode } from "./format.ts";
import "./App.css";

function videoFromHash(): string | undefined {
  const v = new URLSearchParams(location.hash.slice(1)).get("video");
  return v ?? undefined;
}

const SIDEBARS = {
  left: { key: "coanda.leftWidth", initial: 236, min: 160, max: 520 },
  right: { key: "coanda.rightWidth", initial: 340, min: 260, max: 640 },
  agent: { key: "coanda.agentWidth", initial: 380, min: 280, max: 760 },
};

/** A sidebar width remembered in this browser, kept within its limits. */
function useSidebarWidth(side: keyof typeof SIDEBARS) {
  const { key, initial, min, max } = SIDEBARS[side];
  const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)));
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(key));
      return saved ? clamp(saved) : initial;
    } catch {
      return initial;
    }
  });
  const resize = (w: number) => {
    const next = clamp(w);
    setWidth(next);
    try {
      localStorage.setItem(key, String(next));
    } catch {
      // Storage can be unavailable (private window, blocked site data); the width still applies.
    }
  };
  return [width, resize] as const;
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
  const [error, setError] = useState<string | null>(null);
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [showSubtitles, setShowSubtitles] = useState(() => {
    try {
      return localStorage.getItem("coanda.subtitles") === "on";
    } catch {
      return false;
    }
  });
  const [leftWidth, setLeftWidth] = useSidebarWidth("left");
  const [rightWidth, setRightWidth] = useSidebarWidth("right");
  const [agentWidth, setAgentWidth] = useSidebarWidth("agent");
  /** The selected video's project folder; null when it is in none, undefined while unknown. */
  const [project, setProject] = useState<string | null | undefined>(undefined);
  /** A folder clicked in the tree; the Claude panel follows it until a video is chosen. */
  const [selectedFolder, setSelectedFolder] = useState<string | undefined>(undefined);
  const [agent, setAgent] = useState<AgentState | null>(null);
  const [auth, setAuth] = useState<ClaudeAuth | null>(null);
  const [keySaved, setKeySaved] = useState(false);
  const projectRef = useRef(project);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);
  const playerRef = useRef<PlayerHandle>(null);
  const videoRef = useRef(video);
  useEffect(() => {
    videoRef.current = video;
  }, [video]);

  /** Shows a newly chosen folder, starting with no video selected. */
  // The folder shown, so a change of folder can be told apart from a refresh of the same one.
  const rootRef = useRef<string | null | undefined>(undefined);
  const showFolder = useCallback((next: ServerInfo) => {
    if (rootRef.current !== undefined && rootRef.current !== next.root) {
      setVideo(undefined);
      setSelectedFolder(undefined);
      setAnnotations([]);
      setActiveId(null);
      setRenderedAt(null);
      history.replaceState(null, "", location.pathname);
    }
    rootRef.current = next.root;
    setInfo(next);
  }, []);

  const loadAnnotations = useCallback(async (path: string) => {
    // Separately, so a failure fetching the video's settings never hides its annotations.
    const details = api.videoInfo(path).catch(() => null);
    const list = await api.annotations(path);
    if (videoRef.current !== path) return;
    setAnnotations(list);
    setVideoInfo(await details);
  }, []);

  // The folder whose project the Claude panel shows: the clicked folder, else the selected
  // video's folder, else the root.
  const scope =
    selectedFolder ?? (video?.includes("/") ? video.slice(0, video.lastIndexOf("/")) : "");
  const scopeRef = useRef(scope);
  const loadProject = useCallback(async (folder: string) => {
    const { project: found } = await api.projectForFolder(folder).catch(() => ({ project: null }));
    if (scopeRef.current === folder) setProject(found);
  }, []);
  useEffect(() => {
    scopeRef.current = scope;
    if (info?.root) void loadProject(scope);
  }, [scope, info?.root, loadProject]);

  const loadAgent = useCallback(async (folder: string) => {
    const state = await api.agent(folder);
    if (projectRef.current === folder) setAgent(state);
  }, []);

  useEffect(() => {
    if (project == null) return;
    void loadAgent(project);
    if (!auth) void api.claudeAuth().then(setAuth);
  }, [project, loadAgent, auth]);

  useEffect(() => {
    api.info().then(showFolder, (e: Error) => setError(e.message));
    api.tree().then(setTree, (e: Error) => setError(e.message));
    void api.settings().then((s) => setKeySaved(s.elevenLabsKey));
  }, [showFolder]);

  useEffect(() => {
    return subscribe((e) => {
      if (e.type === "root") {
        void api.info().then(showFolder);
        void api.tree().then(setTree);
      }
      if (e.type === "tree") {
        void api.tree().then(setTree);
        void loadProject(scopeRef.current);
      }
      if (e.type === "annotations" && e.video === videoRef.current) void loadAnnotations(e.video);
      if (e.type === "video-changed" && e.video === videoRef.current) setRenderedAt(Date.now());
      if (e.type === "agent" && e.project === projectRef.current) void loadAgent(e.project);
    });
  }, [loadAnnotations, showFolder, loadAgent, loadProject]);

  useEffect(() => {
    if (!video) return;
    history.replaceState(null, "", `#video=${encodeURIComponent(video)}`);
    void loadAnnotations(video);
  }, [video, loadAnnotations]);

  const chooseVideo = (path: string) => {
    if (path === video) return;
    setAnnotations([]);
    setVideoInfo(null);
    setActiveId(null);
    setRenderedAt(null);
    setSelectedFolder(undefined);
    setAgent(null);
    setVideo(path);
  };

  const node = video ? findNode(tree, video) : undefined;
  // Send covers the selected video's project when it has one, else the whole folder.
  const projectNode = project ? findNode(tree, project) : undefined;
  const openTotal = sumVideos(projectNode ? [projectNode] : tree, (n) => n.open ?? 0);
  const makeProject = async (folder: string) => {
    await api.makeProject(folder);
    setSelectedFolder(folder);
    setProject(folder);
    setTree(await api.tree());
  };

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
      <Header rootName={info.rootName} video={video} reviewers={reviewers}>
        <Settings
          elevenLabsKeySaved={keySaved}
          onSaveKey={async (key) => {
            setKeySaved((await api.saveElevenLabsKey(key)).elevenLabsKey);
          }}
        />
      </Header>
      <div
        className="columns"
        style={{
          gridTemplateColumns: `${leftWidth}px minmax(0, 1fr) ${rightWidth}px ${agentWidth}px`,
        }}
      >
        <Splitter side="left" offset={leftWidth} width={leftWidth} onResize={setLeftWidth} />
        <Splitter
          side="right"
          offset={rightWidth + agentWidth}
          width={rightWidth}
          onResize={setRightWidth}
        />
        <Splitter side="right" offset={agentWidth} width={agentWidth} onResize={setAgentWidth} />
        <VideoTree
          rootName={info.rootName}
          rootPath={info.root}
          recent={info.recent}
          onBrowse={async () => {
            const { picked, info: next } = await api.pickFolder();
            if (!picked) return;
            showFolder(next);
            setTree(await api.tree());
          }}
          onChooseRoot={async (path) => {
            showFolder(await api.setRoot(path));
            setTree(await api.tree());
          }}
          tree={tree}
          selected={selectedFolder ?? video}
          onSelect={chooseVideo}
          onSelectFolder={setSelectedFolder}
          onMakeProject={(folder) => void run(makeProject(folder))}
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
            voiceReady={videoInfo?.voiceReady ?? false}
            onToggleVoice={() => {
              const next = !(videoInfo?.voiceReady ?? false);
              setVideoInfo((v) => (v ? { ...v, voiceReady: next } : v));
              void run(api.setVoiceReady(video, next));
            }}
            subtitles={(videoInfo?.subtitles ?? []).map(subtitleUrl)}
            showSubtitles={showSubtitles}
            onToggleSubtitles={() => {
              const next = !showSubtitles;
              setShowSubtitles(next);
              try {
                localStorage.setItem("coanda.subtitles", next ? "on" : "off");
              } catch {
                // Storage unavailable: the switch still works for this page.
              }
            }}
            onSelect={select}
            onDeselect={() => setActiveId(null)}
            onCreate={async (draft) => {
              const created = await api.create(video, draft);
              setAnnotations((list) => [...list.filter((a) => a.id !== created.id), created]);
              setActiveId(created.id);
            }}
          />
        ) : (
          <main className="player empty" />
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
          onSend={() =>
            void run(
              api.send(project).then(() => {
                if (video) void loadAnnotations(video);
                void api.tree().then(setTree);
              }),
            )
          }
        />
        <AgentPanel
          project={project}
          onMakeProject={() => void run(makeProject(scope))}
          state={agent}
          auth={auth}
          onMessage={async (text) => {
            if (project == null) return;
            await run(api.agentMessage(project, text).then(setAgent));
          }}
          onStop={() => project != null && void run(api.agentStop(project).then(setAgent))}
          onLogin={() => {
            void run(api.claudeLogin());
            // Check again once the browser sign-in has had time to finish.
            setTimeout(() => void api.claudeAuth().then(setAuth), 15000);
          }}
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
