import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentQuestion,
  AgentState,
  Annotation,
  ClaudeAuth,
  PlanningStep,
  ProjectSettings,
  ServerInfo,
  TreeNode,
  VideoInfo,
} from "../shared/types.ts";
import { PROJECT_VIDEOS } from "../shared/types.ts";
import {
  api,
  mediaUrl,
  subscribe,
  subtitleUrl,
  type NewAnnotation,
  type SavedKeys,
} from "./api.ts";
import { AvatarsContext } from "./avatars.ts";
import { AgentPanel } from "./components/AgentPanel.tsx";
import { AnnotationList } from "./components/AnnotationList.tsx";
import { DocView, type DocViewHandle } from "./components/DocView.tsx";
import { Header } from "./components/Header.tsx";
import { Player, type PlayerHandle } from "./components/Player.tsx";
import { ProjectHome } from "./components/ProjectHome.tsx";
import { Settings } from "./components/Settings.tsx";
import { Splitter } from "./components/Splitter.tsx";
import { VideoTree } from "./components/VideoTree.tsx";
import { findNode, isDocument, isViewable, newestVideo, sumOwned } from "./format.ts";
import { FileView } from "./components/FileView.tsx";
import { Identity } from "./components/Identity.tsx";
import "./App.css";

function videoFromHash(): string | undefined {
  const v = new URLSearchParams(location.hash.slice(1)).get("video");
  return v ?? undefined;
}

const SIDEBARS = {
  left: { key: "howreel.leftWidth", initial: 236, min: 160, max: 520 },
  right: { key: "howreel.rightWidth", initial: 340, min: 260, max: 640 },
  agent: { key: "howreel.agentWidth", initial: 380, min: 280, max: 760 },
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
      return localStorage.getItem("howreel.subtitles") !== "off";
    } catch {
      return true;
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
  const [settings, setSettings] = useState<ProjectSettings>({});
  const app = settings.app ?? null;
  const [auth, setAuth] = useState<ClaudeAuth | null>(null);
  const [keys, setKeys] = useState<SavedKeys>({ elevenLabsKey: null, openRouterKey: null });
  const projectRef = useRef(project);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);
  const playerRef = useRef<PlayerHandle>(null);
  const docRef = useRef<DocViewHandle>(null);
  /** Counts changes on disk to the open document, so it reloads. */
  const [docVersion, setDocVersion] = useState(0);
  /** The project's planning documents. */
  const [steps, setSteps] = useState<PlanningStep[]>([]);
  /** Claude's questions to the reviewer in this project. */
  const [projectQuestions, setQuestions] = useState<AgentQuestion[]>([]);
  const videoRef = useRef(video);
  useEffect(() => {
    videoRef.current = video;
  }, [video]);
  const chooseVideoRef = useRef<(path: string) => void>(() => {});

  /** Shows a newly chosen folder, starting with no video selected. */
  // The folder shown, so a change of folder can be told apart from a refresh of the same one.
  const rootRef = useRef<string | null | undefined>(undefined);
  const showFolder = useCallback((next: ServerInfo) => {
    if (rootRef.current !== undefined && rootRef.current !== next.root) {
      videoRef.current = undefined;
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

  /** Refreshes the selected video's subtitles and unvoiced lines, keeping them if that fails. */
  const loadVideoInfo = useCallback(async (path: string) => {
    const details = await api.videoInfo(path).catch(() => undefined);
    if (details && videoRef.current === path) setVideoInfo(details);
  }, []);

  // The folder whose project the Claude panel shows: the clicked folder, else the selected
  // video's folder, else the root.
  const scope =
    selectedFolder ?? (video?.includes("/") ? video.slice(0, video.lastIndexOf("/")) : "");
  const scopeRef = useRef(scope);
  const loadProject = useCallback(async (folder: string) => {
    const { project: found } = await api.projectForFolder(folder).catch(() => ({ project: null }));
    if (scopeRef.current !== folder) return;
    // Another project's chat is never shown while this one's loads.
    if (found !== projectRef.current) setAgent(null);
    setProject(found);
  }, []);
  useEffect(() => {
    scopeRef.current = scope;
    if (info?.root) void loadProject(scope);
  }, [scope, info?.root, loadProject]);

  const loadQuestions = useCallback(async (folder: string) => {
    const list = await api.questions(folder).catch(() => []);
    if (projectRef.current === folder) setQuestions(list);
  }, []);
  useEffect(() => {
    if (project != null) void loadQuestions(project);
  }, [project, loadQuestions]);

  /** When the draft video was asked for, or null. */
  const [draftRequested, setDraftRequested] = useState<string | null>(null);
  const loadSteps = useCallback(async (folder: string) => {
    const [list, draft] = await Promise.all([
      api.planning(folder).catch(() => []),
      api.draft(folder).catch(() => ({ requestedAt: null })),
    ]);
    if (projectRef.current !== folder) return;
    setSteps(list);
    setDraftRequested(draft.requestedAt);
  }, []);
  useEffect(() => {
    if (project != null) void loadSteps(project);
  }, [project, loadSteps]);

  const loadAgent = useCallback(async (folder: string) => {
    const [state, settings] = await Promise.all([
      api.agent(folder),
      api.projectSettings(folder).catch(() => ({})),
    ]);
    if (projectRef.current !== folder) return;
    setAgent(state);
    setSettings(settings);
  }, []);

  useEffect(() => {
    if (project == null) return;
    void loadAgent(project);
  }, [project, loadAgent]);

  useEffect(() => {
    void api.claudeAuth().then(setAuth, () => {});
  }, []);

  // Until Claude Code is installed and logged in, keep asking: both happen outside HowReel.
  const loggedIn = auth?.loggedIn ?? true;
  useEffect(() => {
    if (loggedIn) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible")
        void api
          .claudeAuth()
          .then(setAuth)
          .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [loggedIn]);

  useEffect(() => {
    api.info().then(showFolder, (e: Error) => setError(e.message));
    api.tree().then(setTree, (e: Error) => setError(e.message));
    void api.settings().then(setKeys);
  }, [showFolder]);

  useEffect(() => {
    return subscribe(
      (e) => {
        if (e.type === "root") {
          void api.info().then(showFolder);
          void api.tree().then(setTree);
        }
        if (e.type === "tree") {
          void api.tree().then(setTree);
          void loadProject(scopeRef.current);
          if (projectRef.current != null) void loadSteps(projectRef.current);
          // A subtitle file appearing beside the open video changes only the tree.
          const v = videoRef.current;
          if (v && !isDocument(v) && !isViewable(v)) void loadVideoInfo(v);
        }
        if (e.type === "annotations" && e.video === videoRef.current) void loadAnnotations(e.video);
        if (e.type === "video-changed" && e.video === videoRef.current) setRenderedAt(Date.now());
        if (e.type === "doc-changed" && e.path === videoRef.current) setDocVersion((v) => v + 1);
        if (e.type === "agent" && e.project === projectRef.current) void loadAgent(e.project);
        if (e.type === "show") chooseVideoRef.current(e.video);
        if (e.type === "questions" && e.project === projectRef.current) {
          void loadQuestions(e.project);
        }
      },
      () => {
        // Connected, or reconnected after the server restarted: show what it has now.
        void api.info().then(showFolder);
        void api.tree().then(setTree);
        if (videoRef.current) void loadAnnotations(videoRef.current);
        if (projectRef.current != null) {
          void loadAgent(projectRef.current);
          void loadQuestions(projectRef.current);
        }
      },
    );
  }, [
    loadAnnotations,
    loadVideoInfo,
    showFolder,
    loadAgent,
    loadProject,
    loadSteps,
    loadQuestions,
  ]);

  useEffect(() => {
    if (!video) return;
    history.replaceState(null, "", `#video=${encodeURIComponent(video)}`);
    void loadAnnotations(video);
  }, [video, loadAnnotations]);

  const chooseVideo = (path: string) => {
    // Choosing it again brings it back in front of a folder's page.
    setSelectedFolder(undefined);
    if (path === video) return;
    setAnnotations([]);
    setVideoInfo(null);
    setActiveId(null);
    setRenderedAt(null);
    // At once, so a response still on its way for the previous video is not shown on this one.
    videoRef.current = path;
    setVideo(path);
  };
  useEffect(() => {
    chooseVideoRef.current = chooseVideo;
  });

  const node = video ? findNode(tree, video) : undefined;
  // Send covers the selected video's project when it has one, else what is in no project.
  const projectNode = project ? findNode(tree, project) : undefined;
  // The draft step opens the newest video in the project made since the draft was asked for.
  const newest = draftRequested ? newestVideo(projectNode?.children ?? []) : undefined;
  const draftVideo =
    newest && (newest.mtime ?? 0) >= Date.parse(draftRequested ?? "") ? newest : undefined;
  // A project's draft video is approved like a planning document, and leads to the voiced one.
  const isDraft = project != null && !!video && video.split("/").pop() === PROJECT_VIDEOS[0].file;
  const hasVoiced = !!video && !!findNode(tree, video.replace(/[^/]+$/, PROJECT_VIDEOS[1].file));
  const questions = project == null ? [] : projectQuestions;
  // What Send sends: the open notes.
  const openTotal = sumOwned(projectNode?.children ?? tree, (n) => n.open ?? 0);
  const makeProject = async (folder: string) => {
    await api.makeProject(folder);
    setSelectedFolder(folder);
    setAgent(null);
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
    if (a.kind === "text") docRef.current?.reveal(a);
    else playerRef.current?.seek(a.t);
  };

  const run = (p: Promise<unknown>) => p.catch((e: Error) => setError(e.message));

  /** Shows a video's annotations as a request returned them, unless another video is open by then. */
  const annotationsOf = (path: string) => (list: Annotation[]) => {
    if (videoRef.current === path) setAnnotations(list);
  };

  /** Adds an annotation. A failure is shown and rethrown, so the draft stays open to try again. */
  const createAnnotation = async (path: string, draft: NewAnnotation) => {
    try {
      const created = await api.create(path, draft);
      if (videoRef.current !== path) return;
      setAnnotations((list) => [...list.filter((a) => a.id !== created.id), created]);
      setActiveId(created.id);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  };

  /** Asks Claude to build the draft video from the approved script. */
  const makeDraft = () => {
    if (project == null) return;
    void run(
      api.makeDraft(project).then((d) => {
        setDraftRequested(d.requestedAt);
        void loadAgent(project);
      }),
    );
  };

  /** Starts a planning document from its template and opens it; Claude begins on it. */
  const startStep = (step: PlanningStep) => {
    if (project == null) return;
    void run(
      api.startPlanning(project, step.key).then(async ({ path }) => {
        setTree(await api.tree());
        chooseVideo(path);
        void loadSteps(project);
        void loadAgent(project);
      }),
    );
  };
  const showError = useCallback((message: string) => setError(message), []);
  // An error goes away by itself after a while.
  useEffect(() => {
    if (!error || !info) return;
    const timer = setTimeout(() => setError(null), 8000);
    return () => clearTimeout(timer);
  }, [error, info]);
  const openPath = (path: string) => void run(api.openPath(path, project));

  if (error && !info)
    return <div className="fatal">Could not reach the HowReel server: {error}</div>;
  if (!info) return null;

  return (
    <AvatarsContext.Provider value={info.avatars}>
      <div className="app">
        <Header reviewers={reviewers.filter((r) => r !== info.user)}>
          <Identity
            name={info.user}
            email={info.email}
            auth={auth}
            onLogin={() => void run(api.claudeLogin())}
            onSwitch={() => void run(api.claudeSwitch().then(() => api.claudeAuth().then(setAuth)))}
          />
          <Settings
            saved={keys}
            onSaveKey={async (which, key) => setKeys(await api.saveKey(which, key))}
            app={
              project != null
                ? {
                    path: app,
                    onChoose: () =>
                      void run(
                        api
                          .chooseApp(project)
                          .then((r) => setSettings((s) => ({ ...s, app: r.app ?? undefined }))),
                      ),
                  }
                : undefined
            }
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
            onReveal={(path) => void run(api.reveal(path))}
            onOpen={openPath}
            onRename={async (path, name) => {
              try {
                const r = await api.rename(path, name);
                if (path === video) chooseVideo(r.path);
              } catch (e) {
                setError((e as Error).message);
                throw e;
              }
            }}
            onDelete={(path) =>
              void run(
                api.deleteFile(path).then(() => {
                  if (path === videoRef.current) {
                    videoRef.current = undefined;
                    setVideo(undefined);
                    setAnnotations([]);
                    setVideoInfo(null);
                    history.replaceState(null, "", location.pathname);
                  }
                }),
              )
            }
          />
          {project != null && selectedFolder === project ? (
            <ProjectHome
              project={project || info.rootName}
              steps={steps}
              onOpen={(step) => chooseVideo(step.path)}
              onStart={startStep}
              draftRequested={draftRequested}
              draftVideo={draftVideo?.path ?? null}
              onOpenDraft={chooseVideo}
              onMakeDraft={makeDraft}
            />
          ) : video && node && isDocument(video) ? (
            <DocView
              key={video}
              path={video}
              version={docVersion}
              annotations={annotations}
              activeId={activeId}
              showResolved={showResolved}
              me={info.user}
              ref={docRef}
              onSelect={select}
              onDeselect={() => setActiveId(null)}
              onCreate={(draft) => createAnnotation(video, draft)}
              onOpenPath={openPath}
              onError={showError}
              step={steps.find((s) => s.path === video)}
              nextStep={steps[steps.findIndex((s) => s.path === video) + 1]}
              isLastStep={steps.at(-1)?.path === video}
              draftRequested={draftRequested}
              onMakeDraft={makeDraft}
              onNextStep={(next) => (next.started ? chooseVideo(next.path) : startStep(next))}
              onApprove={(approved) =>
                void run(
                  api.approve(video, approved).then(async () => {
                    if (project != null) await loadSteps(project);
                  }),
                )
              }
            />
          ) : video && node && isViewable(video) ? (
            <FileView path={video} mtime={node.mtime} />
          ) : video && node ? (
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
              unvoiced={videoInfo?.unvoiced ?? []}
              approved={videoInfo?.approved}
              onApprove={
                isDraft
                  ? (approved) =>
                      void run(api.approve(video, approved).then(() => loadVideoInfo(video)))
                  : undefined
              }
              onMakeVoiced={
                isDraft && !hasVoiced
                  ? () => void run(api.voicePass(project!, video).then(setAgent))
                  : undefined
              }
              subtitles={(videoInfo?.subtitles ?? []).map(subtitleUrl)}
              showSubtitles={showSubtitles}
              onToggleSubtitles={() => {
                const next = !showSubtitles;
                setShowSubtitles(next);
                try {
                  localStorage.setItem("howreel.subtitles", next ? "on" : "off");
                } catch {
                  // Storage unavailable: the switch still works for this page.
                }
              }}
              onSelect={select}
              onDeselect={() => setActiveId(null)}
              onCreate={(draft) => createAnnotation(video, draft)}
            />
          ) : (
            <main className="player empty" />
          )}
          <AnnotationList
            key={`notes:${video}`}
            annotations={annotations}
            activeId={activeId}
            showResolved={showResolved}
            onToggleResolved={() => setShowResolved((s) => !s)}
            onSelect={select}
            onResolve={(a) => void run(api.resolve(video!, a.id).then(annotationsOf(video!)))}
            onReopen={(a) => void run(api.reopen(video!, a.id).then(annotationsOf(video!)))}
            onReply={async (a, text, images) => {
              await run(api.reply(video!, a.id, text, images).then(annotationsOf(video!)));
            }}
            onEdit={async (a, change) => {
              await run(api.edit(video!, a.id, change).then(annotationsOf(video!)));
            }}
            onDelete={(a) => {
              if (activeId === a.id) setActiveId(null);
              void run(api.remove(video!, a.id).then(annotationsOf(video!)));
            }}
            openTotal={openTotal}
            onOpenPath={openPath}
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
            questions={questions}
            onAnswer={(q, text) =>
              project != null && void run(api.answer(project, q.id, text).then(setQuestions))
            }
            onDeleteQuestion={(q) =>
              project != null && void run(api.deleteQuestion(project, q.id).then(setQuestions))
            }
            onMakeProject={() => void run(makeProject(scope))}
            model={settings.model ?? ""}
            effort={settings.effort ?? ""}
            onModel={(model) =>
              project != null &&
              void run(api.setProjectSettings(project, { model }).then(setSettings))
            }
            onEffort={(effort) =>
              project != null &&
              void run(api.setProjectSettings(project, { effort }).then(setSettings))
            }
            state={agent}
            auth={auth}
            onMessage={async (text, images) => {
              if (project == null) return;
              await run(api.agentMessage(project, text, images).then(setAgent));
            }}
            onStop={() => project != null && void run(api.agentStop(project).then(setAgent))}
            onOpenPath={openPath}
            onCompact={() => project != null && void run(api.agentCompact(project).then(setAgent))}
            onLogin={() => void run(api.claudeLogin())}
          />
        </div>
        {error && (
          <div className="toast" role="alert" data-testid="toast">
            <span>{error}</span>
            <button className="toast-close" aria-label="Close" onClick={() => setError(null)}>
              ×
            </button>
          </div>
        )}
      </div>
    </AvatarsContext.Provider>
  );
}

export default App;
