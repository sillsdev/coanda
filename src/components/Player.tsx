import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Annotation } from "../../shared/types.ts";
import type { NewAnnotation } from "../api.ts";
import { avatarColor, formatTime, initials, stem } from "../format.ts";
import { PauseIcon, PlayIcon } from "./icons.tsx";

/** How close (in seconds) the playhead must be for an annotation to show on the frame. */
const SHOW_WINDOW = 1.5;
/** A press that moves less than this many pixels is a pin, not an arrow. */
const ARROW_MIN_PX = 10;

interface Draft {
  kind: "pin" | "arrow";
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  text: string;
}

export interface PlayerHandle {
  /** Pauses and jumps to a time, in seconds. */
  seek: (time: number) => void;
}

interface Props {
  video: string;
  src: string;
  annotations: Annotation[];
  activeId: number | null;
  showResolved: boolean;
  me: string;
  ref?: Ref<PlayerHandle>;
  renderedAt: number | null;
  onSelect: (a: Annotation) => void;
  onDeselect: () => void;
  onCreate: (a: NewAnnotation) => Promise<void>;
}

export function Player(props: Props) {
  const { video, src, annotations, activeId, showResolved, me, renderedAt, ref } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const [t, setT] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [aspect, setAspect] = useState(16 / 9);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [drag, setDrag] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  // Fit the stage to the video's shape inside the space available.
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const fit = () => {
      const { width, height } = area.getBoundingClientRect();
      const w = Math.min(width, height * aspect);
      setStage({ w, h: w / aspect });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(area);
    return () => ro.disconnect();
  }, [aspect]);

  // Follow the playhead smoothly while playing.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      if (videoRef.current) setT(videoRef.current.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  useImperativeHandle(
    ref,
    () => ({
      seek: (time: number) => {
        const v = videoRef.current;
        if (!v) return;
        v.pause();
        v.currentTime = time;
        setT(time);
        setDraft(null);
      },
    }),
    [],
  );

  const pause = () => videoRef.current?.pause();

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      setDraft(null);
      if (v.ended) v.currentTime = 0;
      void v.play();
    } else v.pause();
  };

  const seekFromPointer = (clientX: number) => {
    const track = trackRef.current;
    const v = videoRef.current;
    if (!track || !v || !duration) return;
    const r = track.getBoundingClientRect();
    const next = Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
    pause();
    v.currentTime = next;
    setT(next);
    setDraft(null);
  };

  const pointOnStage = (e: ReactPointerEvent) => {
    const r = stageRef.current!.getBoundingClientRect();
    const clamp = (n: number) => Math.min(100, Math.max(0, n));
    return {
      x: clamp(((e.clientX - r.left) / r.width) * 100),
      y: clamp(((e.clientY - r.top) / r.height) * 100),
    };
  };

  const onStageDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    pause();
    const p = pointOnStage(e);
    setDrag({ x: p.x, y: p.y, x2: p.x, y2: p.y });
    setDraft(null);
    props.onDeselect();
  };

  const onStageMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const p = pointOnStage(e);
    setDrag({ ...drag, x2: p.x, y2: p.y });
  };

  const onStageUp = () => {
    if (!drag) return;
    const dist = Math.hypot(
      ((drag.x2 - drag.x) * stage.w) / 100,
      ((drag.y2 - drag.y) * stage.h) / 100,
    );
    setDraft(
      dist > ARROW_MIN_PX
        ? { kind: "arrow", x: drag.x, y: drag.y, x2: drag.x2, y2: drag.y2, text: "" }
        : { kind: "pin", x: drag.x, y: drag.y, text: "" },
    );
    setDrag(null);
    setTimeout(() => textRef.current?.focus(), 0);
  };

  const captureFrame = (): string | undefined => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return undefined;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")?.drawImage(v, 0, 0);
    try {
      return canvas.toDataURL("image/png");
    } catch {
      return undefined;
    }
  };

  const saveDraft = async () => {
    if (!draft || !draft.text.trim() || saving) return;
    setSaving(true);
    try {
      await props.onCreate({ ...draft, t: Math.round(t * 10) / 10, frameDataUrl: captureFrame() });
      setDraft(null);
    } finally {
      setSaving(false);
    }
  };

  // What to draw on the frame.
  const visible = annotations.filter(
    (a) => (a.status !== "resolved" || showResolved) && Math.abs(a.t - t) <= SHOW_WINDOW,
  );
  const px = (xPct: number, yPct: number) => ({
    x: (xPct / 100) * stage.w,
    y: (yPct / 100) * stage.h,
  });
  const arrows: {
    key: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    dashed: boolean;
    opacity: number;
  }[] = [];
  for (const a of visible) {
    if (a.kind === "arrow" && a.x2 !== undefined && a.y2 !== undefined) {
      const p = px(a.x, a.y);
      const q = px(a.x2, a.y2);
      arrows.push({
        key: `a${a.id}`,
        x1: p.x,
        y1: p.y,
        x2: q.x,
        y2: q.y,
        dashed: false,
        opacity: a.id === activeId ? 1 : 0.8,
      });
    }
  }
  if (draft?.kind === "arrow") {
    const p = px(draft.x, draft.y);
    const q = px(draft.x2!, draft.y2!);
    arrows.push({ key: "draft", x1: p.x, y1: p.y, x2: q.x, y2: q.y, dashed: false, opacity: 1 });
  }
  if (
    drag &&
    Math.hypot(((drag.x2 - drag.x) * stage.w) / 100, ((drag.y2 - drag.y) * stage.h) / 100) > 4
  ) {
    const p = px(drag.x, drag.y);
    const q = px(drag.x2, drag.y2);
    arrows.push({ key: "drag", x1: p.x, y1: p.y, x2: q.x, y2: q.y, dashed: true, opacity: 0.9 });
  }

  let popStyle: CSSProperties = {};
  if (draft) {
    const ex = draft.kind === "arrow" ? draft.x2! : draft.x;
    const ey = draft.kind === "arrow" ? draft.y2! : draft.y;
    const tx = ex > 58 ? "calc(-100% - 22px)" : "22px";
    const ty = ey > 52 ? "calc(-100% + 24px)" : "-24px";
    popStyle = { left: `${ex}%`, top: `${ey}%`, transform: `translate(${tx}, ${ty})` };
  }

  const marks = annotations.filter((a) => a.status !== "resolved" || showResolved);
  const progress = duration ? (t / duration) * 100 : 0;
  const folder = video.includes("/") ? video.slice(0, video.lastIndexOf("/") + 1) : "";

  return (
    <main className="player">
      <div className="title-row">
        <div className="title-block">
          <div className="title" data-testid="video-title">
            {stem(video.split("/").pop() ?? video)}
          </div>
          <div className="subtitle">
            {folder && <span className="mono">{folder}</span>}
            {folder && " · "}
            {formatTime(duration)}
          </div>
        </div>
        {renderedAt && (
          <span className="fresh" data-testid="fresh-render">
            <span className="dot" />
            New render at{" "}
            {new Date(renderedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </span>
        )}
      </div>

      <div className="stage-area" ref={areaRef}>
        <div
          ref={stageRef}
          className="stage"
          data-testid="stage"
          style={{ width: stage.w, height: stage.h }}
          onPointerDown={onStageDown}
          onPointerMove={onStageMove}
          onPointerUp={onStageUp}
        >
          <div className="screen">
            <video
              ref={videoRef}
              src={src}
              preload="auto"
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                setDuration(v.duration);
                if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
              }}
              onDurationChange={(e) => setDuration(e.currentTarget.duration)}
              onPlay={() => setPlaying(true)}
              onPause={(e) => {
                setPlaying(false);
                setT(e.currentTarget.currentTime);
              }}
              onSeeked={(e) => setT(e.currentTarget.currentTime)}
            />
            {!playing && (
              <div className="paused-pill">
                <PauseIcon size={10} />
                <span>PAUSED {formatTime(t)}</span>
              </div>
            )}
          </div>
          <svg className="overlay" width={stage.w} height={stage.h}>
            {arrows.map((a) => (
              <Arrow
                key={a.key}
                x1={a.x1}
                y1={a.y1}
                x2={a.x2}
                y2={a.y2}
                dashed={a.dashed}
                opacity={a.opacity}
              />
            ))}
          </svg>
          {visible.map((a) => (
            <div
              key={a.id}
              className={`pin${a.id === activeId ? " active" : ""}`}
              data-testid={`pin-${a.id}`}
              style={{ left: `${a.x}%`, top: `${a.y}%` }}
              onPointerDown={(e) => {
                e.stopPropagation();
                props.onSelect(a);
              }}
            >
              {a.id}
            </div>
          ))}
          {draft?.kind === "pin" && (
            <div className="pin active" style={{ left: `${draft.x}%`, top: `${draft.y}%` }}>
              +
            </div>
          )}
          {draft && (
            <div
              className="draft"
              data-testid="draft"
              style={popStyle}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
            >
              <div className="draft-head">
                <span className="avatar small" style={{ background: avatarColor(me) }}>
                  {initials(me)}
                </span>
                <span className="draft-name">{me}</span>
                <span className="draft-meta mono">
                  {draft.kind === "arrow" ? "ARROW" : "PIN"} · {formatTime(t)}
                </span>
              </div>
              <textarea
                ref={textRef}
                className="field"
                rows={3}
                placeholder="What should change here?"
                value={draft.text}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void saveDraft();
                  if (e.key === "Escape") setDraft(null);
                }}
              />
              <div className="draft-actions">
                <span className="mono hint-key">Ctrl+↵ save</span>
                <button className="btn btn-ghost-outline" onClick={() => setDraft(null)}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => void saveDraft()}
                  disabled={!draft.text.trim() || saving}
                >
                  Comment
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="controls">
        <button
          className="play-btn"
          onClick={togglePlay}
          title="Play / pause"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? <PauseIcon /> : <PlayIcon className="nudge" />}
        </button>
        <div
          ref={trackRef}
          className="track"
          data-testid="track"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seekFromPointer(e.clientX);
          }}
          onPointerMove={(e) => {
            if (e.buttons === 1) seekFromPointer(e.clientX);
          }}
        >
          <div className="track-rail" />
          <div className="track-fill" style={{ width: `${progress}%` }} />
          <div className="track-thumb" style={{ left: `${progress}%` }} />
          {duration > 0 &&
            marks.map((a) => (
              <div
                key={a.id}
                className={`mark${a.id === activeId ? " active" : ""}${a.status === "resolved" ? " resolved" : ""}`}
                style={{ left: `${(a.t / duration) * 100}%` }}
                title={`${formatTime(a.t)} · ${a.text}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  props.onSelect(a);
                }}
              >
                {a.id}
              </div>
            ))}
        </div>
        <span className="time mono" data-testid="time">
          {formatTime(t)} / {formatTime(duration)}
        </span>
      </div>
      <div className="hints">
        <span>
          <span className="key mono">Click</span>comment on a spot
        </span>
        <span>
          <span className="key mono">Drag</span>draw an arrow
        </span>
        <span className="dim">Playback pauses when you annotate</span>
      </div>
    </main>
  );
}

function Arrow({
  x1,
  y1,
  x2,
  y2,
  dashed,
  opacity,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  dashed: boolean;
  opacity: number;
}) {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const L = 14;
  const W = 8;
  const bx = x2 - ux * L;
  const by = y2 - uy * L;
  const ex = x2 - ux * L * 0.6;
  const ey = y2 - uy * L * 0.6;
  const head = `${x2},${y2} ${bx - uy * W},${by + ux * W} ${bx + uy * W},${by - ux * W}`;
  return (
    <g opacity={opacity}>
      <line
        x1={x1}
        y1={y1}
        x2={ex}
        y2={ey}
        stroke="#0a1222"
        strokeOpacity={0.55}
        strokeWidth={6}
        strokeLinecap="round"
      />
      <line
        x1={x1}
        y1={y1}
        x2={ex}
        y2={ey}
        stroke="#4a7fe0"
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={dashed ? "7 5" : undefined}
      />
      <polygon points={head} fill="#4a7fe0" stroke="#0a1222" strokeOpacity={0.4} strokeWidth={1} />
    </g>
  );
}
