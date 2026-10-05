import { useEffect, useRef, useState } from "react";
import type { AgentState, ClaudeAuth } from "../../shared/types.ts";
import { usePastedImages } from "../pastedImages.ts";
import { AgentStatusBadge } from "./AgentStatusBadge.tsx";
import { SendIcon } from "./icons.tsx";
import { Linkify, Markdown } from "./Linkify.tsx";
import { Thumbs } from "./PastedImages.tsx";
import { SessionMeter } from "./SessionMeter.tsx";

interface Props {
  /** The project's folder; null when the selection is in no project; undefined while unknown. */
  project: string | null | undefined;
  onMakeProject: () => void;
  /** The project's Bloom worktree; null when none is chosen. */
  bloom: string | null;
  onChooseBloom: () => void;
  model: string;
  effort: string;
  onModel: (model: string) => void;
  onEffort: (effort: string) => void;
  onCompact: () => void;
  state: AgentState | null;
  auth: ClaudeAuth | null;
  /** Sends a message, with any images pasted into it as data URLs. */
  onMessage: (text: string, images: string[]) => Promise<void>;
  onStop: () => void;
  onLogin: () => void;
  onOpenPath: (path: string) => void;
}

/** The video project's Claude session: its messages, a box to talk to it, and Stop. */
export function AgentPanel(props: Props) {
  const { project, state, auth, onMessage, onStop, onLogin } = props;
  const [text, setText] = useState("");
  const pasted = usePastedImages();
  const listRef = useRef<HTMLDivElement>(null);
  const status = state?.status ?? "idle";
  const count = state?.messages.length ?? 0;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  if (project === undefined) {
    return (
      <section className="panel agent-panel" data-testid="agent-panel">
        <div className="panel-head">
          <div className="panel-title">Claude</div>
        </div>
      </section>
    );
  }

  if (project === null) {
    return (
      <section className="panel agent-panel" data-testid="agent-panel">
        <div className="panel-head">
          <div className="panel-title">Claude</div>
        </div>
        <div className="agent-none">
          <p>No project in this folder or above it.</p>
          <button className="btn btn-primary" onClick={props.onMakeProject}>
            Make project here
          </button>
        </div>
      </section>
    );
  }

  const submit = async () => {
    if (!text.trim() && !pasted.images.length) return;
    const sending = text;
    const images = pasted.images;
    setText("");
    pasted.clear();
    await onMessage(sending, images);
  };

  return (
    <section className="panel agent-panel" data-testid="agent-panel">
      <div className="panel-head">
        <div className="panel-title">Claude</div>
        <span className="agent-project mono" title={project || "/"}>
          {project.split("/").pop() || "/"}
        </span>
      </div>
      <div className="agent-bloom">
        <span className="eyebrow">Bloom</span>
        {props.bloom ? (
          <>
            <span className="agent-bloom-path mono" title={props.bloom}>
              {props.bloom}
            </span>
            <button className="link-btn small-btn" onClick={props.onChooseBloom}>
              Change…
            </button>
          </>
        ) : (
          <button className="link-btn small-btn" onClick={props.onChooseBloom}>
            Choose…
          </button>
        )}
      </div>
      {auth && !auth.loggedIn ? (
        <div className="agent-login">
          <button className="btn btn-primary" onClick={onLogin}>
            Log in to Claude
          </button>
        </div>
      ) : (
        <>
          <div className="agent-log" ref={listRef} data-testid="agent-log">
            {state?.messages.map((m, i) => (
              <div
                key={i}
                className={`agent-msg ${m.role}${m.role === "user" ? " chat-human" : m.role === "assistant" ? " chat-ai" : ""}`}
              >
                {m.role === "assistant" ? (
                  <Markdown text={m.text} onOpenPath={props.onOpenPath} />
                ) : (
                  <Linkify text={m.text} onOpenPath={props.onOpenPath} />
                )}
                {m.images && <Thumbs saved={m.images} onOpen={props.onOpenPath} />}
              </div>
            ))}
          </div>
          <div className="agent-status">
            <AgentStatusBadge status={status} />
            {status === "working" && state?.workingSince && <Elapsed since={state.workingSince} />}
            {status === "working" && (
              <button className="link-btn small-btn push-right" onClick={onStop}>
                Stop
              </button>
            )}
          </div>
          <div className="agent-input">
            <textarea
              className="field"
              rows={2}
              placeholder="Message Claude"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={pasted.onPaste}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <button
              className="btn btn-primary"
              aria-label="Send message"
              onClick={() => void submit()}
              disabled={!text.trim() && !pasted.images.length}
            >
              <SendIcon size={14} />
            </button>
          </div>
          <Thumbs pasted={pasted.images} onRemove={pasted.remove} />
          <SessionMeter
            state={state}
            model={props.model}
            effort={props.effort}
            onModel={props.onModel}
            onEffort={props.onEffort}
            onCompact={props.onCompact}
          />
        </>
      )}
    </section>
  );
}

/** Time since `since`, as 45s, 3m 05s or 1h 02m, counting up each second. */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const total = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const text = h ? `${h}h ${pad(m)}m` : m ? `${m}m ${pad(s)}s` : `${s}s`;
  return (
    <span className="elapsed mono" data-testid="elapsed">
      {text}
    </span>
  );
}
