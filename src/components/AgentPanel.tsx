import { useEffect, useRef, useState } from "react";
import type { AgentState, ClaudeAuth } from "../../shared/types.ts";
import { AgentStatusBadge } from "./AgentStatusBadge.tsx";
import { SendIcon } from "./icons.tsx";

interface Props {
  /** The project's folder; null when the selection is in no project; undefined while unknown. */
  project: string | null | undefined;
  onMakeProject: () => void;
  state: AgentState | null;
  auth: ClaudeAuth | null;
  onMessage: (text: string) => Promise<void>;
  onStop: () => void;
  onLogin: () => void;
}

/** The video project's Claude session: its messages, a box to talk to it, and Stop. */
export function AgentPanel(props: Props) {
  const { project, state, auth, onMessage, onStop, onLogin } = props;
  const [text, setText] = useState("");
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
    if (!text.trim()) return;
    const sending = text;
    setText("");
    await onMessage(sending);
  };

  return (
    <section className="panel agent-panel" data-testid="agent-panel">
      <div className="panel-head">
        <div className="panel-title">Claude</div>
        <AgentStatusBadge status={status} />
        <span className="agent-project mono" title={project || "/"}>
          {project.split("/").pop() || "/"}
        </span>
        {status === "working" && (
          <button className="link-btn push-right" onClick={onStop}>
            Stop
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
              <div key={i} className={`agent-msg ${m.role}`}>
                {m.text}
              </div>
            ))}
          </div>
          <div className="agent-input">
            <textarea
              className="field"
              rows={2}
              placeholder="Message Claude"
              value={text}
              onChange={(e) => setText(e.target.value)}
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
              disabled={!text.trim()}
            >
              <SendIcon size={14} />
            </button>
          </div>
        </>
      )}
    </section>
  );
}
