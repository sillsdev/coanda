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
import type { Annotation, UnvoicedLine } from "../../shared/types.ts";
import type { NewAnnotation } from "../api.ts";
import { formatTime } from "../format.ts";
import { CaptionsIcon, MicIcon, PauseIcon, PlayIcon } from "./icons.tsx";
import { usePastedImages } from "../pastedImages.ts";
import { Thumbs } from "./PastedImages.tsx";
import { Avatar } from "./Avatar.tsx";

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
  /** Where the comment box opens, in pixels from the stage's top-left. It grows right and
   * down from there when resized. */
  boxLeft: number;
  boxTop: number;
}

/** The comment box's size when it opens, used to place it beside the pin or arrow tip. */
const BOX_WIDTH = 276;
const BOX_HEIGHT = 190;

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
  /** Narration lines this render has no recording for. */
  unvoiced: UnvoicedLine[];
  /** Asks the project's session to record the missing voice; absent outside a project. */
  onVoicePass?: () => void;
  /** URLs of subtitle tracks for this video, as WebVTT. */
  subtitles: string[];
  showSubtitles: boolean;
  onToggleSubtitles: () => void;
  onSelect: (a: Annotation) => void;
  onDeselect: () => void;
  onCreate: (a: NewAnnotation) => Promise<void>;
}

export function Player(props: Props) {
  const { src, annotations, activeId, showResolved, me, renderedAt, ref } = props;
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
  const pasted = usePastedImages();
  const clearPasted = pasted.clear;
  const hasDraft = draft !== null;

  // Pasted images belong to one draft: they go when it's saved or cancelled.
  useEffect(() => {
    if (!hasDraft) clearPasted();
  }, [hasDraft, clearPasted]);

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

  // Show or hide the subtitle track. The first track is used when there are several.
  const { showSubtitles, subtitles } = props;
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const sync = () => {
      Array.from(v.textTracks).forEach((track, i) => {
        track.mode = showSubtitles && i === 0 ? "showing" : "disabled";
      });
    };
    sync();
    v.textTracks.addEventListener("addtrack", sync);
    return () => v.textTracks.removeEventListener("addtrack", sync);
  }, [showSubtitles, subtitles]);

  // Left and right arrows step the playhead by a second, unless the user is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      const v = videoRef.current;
      if (!v || !Number.isFinite(v.duration)) return;
      e.preventDefault();
      const next = Math.min(
        v.duration,
        Math.max(0, v.currentTime + (e.key === "ArrowLeft" ? -1 : 1)),
      );
      v.currentTime = next;
      setT(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    const isArrow = dist > ARROW_MIN_PX;
    const ex = ((isArrow ? drag.x2 : drag.x) / 100) * stage.w;
    const ey = ((isArrow ? drag.y2 : drag.y) / 100) * stage.h;
    const boxLeft = ex > stage.w * 0.58 ? ex - BOX_WIDTH - 22 : ex + 22;
    const boxTop = Math.max(0, ey > stage.h * 0.52 ? ey - BOX_HEIGHT + 24 : ey - 24);
    setDraft(
      isArrow
        ? {
            kind: "arrow",
            x: drag.x,
            y: drag.y,
            x2: drag.x2,
            y2: drag.y2,
            text: "",
            boxLeft,
            boxTop,
          }
        : { kind: "pin", x: drag.x, y: drag.y, text: "", boxLeft, boxTop },
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

  const draftEmpty = !draft?.text.trim() && !pasted.images.length;

  const saveDraft = async () => {
    if (!draft || draftEmpty || saving) return;
    setSaving(true);
    try {
      await props.onCreate({
        ...draft,
        t: Math.round(t * 10) / 10,
        frameDataUrl: captureFrame(),
        images: pasted.images,
      });
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

  const popStyle: CSSProperties = draft ? { left: draft.boxLeft, top: draft.boxTop } : {};

  const unvoicedNow = props.unvoiced.find((l) => t >= l.start && t < l.end);
  const marks = annotations.filter((a) => a.status !== "resolved" || showResolved);
  const progress = duration ? (t / duration) * 100 : 0;

  return (
    <main
      className="player"
      onClick={(e) => {
        // A click beside the video, where a note might have been meant, plays or pauses it.
        const target = e.target as HTMLElement;
        if (!target.matches(".player, .title-row, .stage-area")) return;
        if (draft && !draftEmpty) return;
        togglePlay();
      }}
    >
      <div className="title-row">
        {renderedAt && (
          <span className="fresh" data-testid="fresh-render">
            <span className="dot" />
            New render
          </span>
        )}
        <button
          className="btn btn-ghost-outline voice-btn"
          data-testid="voice-pass"
          disabled={!props.onVoicePass}
          onClick={props.onVoicePass}
        >
          <MicIcon />
          Voice video
          {props.unvoiced.length > 0 && (
            <span className="count-badge">{props.unvoiced.length}</span>
          )}
        </button>
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
            >
              {props.subtitles.map((url) => (
                <track key={url} kind="subtitles" src={url} />
              ))}
            </video>
            {unvoicedNow && (
              <div className="unvoiced-now" data-testid="unvoiced-now">
                <span className="unvoiced-label">Not voiced</span>
                {unvoicedNow.text}
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
                <Avatar name={me} className="small" />
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
                onPaste={pasted.onPaste}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void saveDraft();
                  if (e.key === "Escape") setDraft(null);
                }}
              />
              <Thumbs pasted={pasted.images} onRemove={pasted.remove} />
              <div className="draft-actions">
                <button className="btn btn-ghost-outline push-right" onClick={() => setDraft(null)}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => void saveDraft()}
                  disabled={draftEmpty || saving}
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
          {duration > 0 &&
            props.unvoiced.map((l, i) => (
              <div
                key={i}
                className="track-unvoiced"
                title={l.text}
                style={{
                  left: `${(l.start / duration) * 100}%`,
                  width: `${(Math.max(l.end - l.start, 0.2) / duration) * 100}%`,
                }}
              />
            ))}
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
              />
            ))}
        </div>
        <span className="time mono" data-testid="time">
          {formatTime(t)} / {formatTime(duration)}
        </span>
        <button
          className={`toggle${props.showSubtitles ? " on" : ""}`}
          aria-pressed={props.showSubtitles}
          disabled={!props.subtitles.length}
          data-testid="subtitles"
          onClick={props.onToggleSubtitles}
        >
          <CaptionsIcon />
          Subtitles
        </button>
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
