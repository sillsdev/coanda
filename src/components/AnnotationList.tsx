import { useEffect, useRef, useState } from "react";
import type { Annotation } from "../../shared/types.ts";
import { avatarColor, formatTime, initials } from "../format.ts";
import { ArrowIcon, CheckIcon, SendIcon } from "./icons.tsx";

interface Props {
  annotations: Annotation[];
  activeId: number | null;
  showResolved: boolean;
  onToggleResolved: () => void;
  onSelect: (a: Annotation) => void;
  onResolve: (a: Annotation) => void;
  onReopen: (a: Annotation) => void;
  onReply: (a: Annotation, text: string) => Promise<void>;
  /** Open annotations across every video in the folder. */
  openTotal: number;
  onSend: () => void;
}

export function AnnotationList(props: Props) {
  const { annotations, activeId, showResolved, openTotal } = props;
  const [replyFor, setReplyFor] = useState<number | null>(null);
  const [replyText, setReplyText] = useState("");
  const replyRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (replyFor !== null) replyRef.current?.focus();
  }, [replyFor]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const unresolved = annotations.filter((a) => a.status !== "resolved");
  const resolvedCount = annotations.length - unresolved.length;
  const shown = annotations
    .filter((a) => a.status !== "resolved" || showResolved)
    .sort((a, b) => a.t - b.t);

  const sendReply = async (a: Annotation) => {
    if (!replyText.trim()) return;
    await props.onReply(a, replyText);
    setReplyFor(null);
    setReplyText("");
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-title">Annotations</div>
        <span className="open-badge" data-testid="unresolved-count">
          {unresolved.length} open
        </span>
        {resolvedCount > 0 && (
          <button className="link-btn push-right" onClick={props.onToggleResolved}>
            {showResolved ? "Hide resolved" : `Show ${resolvedCount} resolved`}
          </button>
        )}
      </div>
      <div className="cards">
        {shown.map((a) => {
          const isActive = a.id === activeId;
          const lastIsClaude = a.thread.at(-1)?.who === "claude";
          const replying = replyFor === a.id;
          return (
            <div
              key={a.id}
              ref={isActive ? activeRef : undefined}
              className={`card${isActive ? " active" : ""}${a.status === "resolved" ? " resolved" : ""}`}
              data-testid={`card-${a.id}`}
              data-status={a.status}
              onClick={() => props.onSelect(a)}
            >
              <div className="card-head">
                <span className="num">{a.id}</span>
                <span
                  className="avatar tiny"
                  title={a.author}
                  style={{ background: avatarColor(a.author) }}
                >
                  {initials(a.author)}
                </span>
                <span className="card-author">{a.author}</span>
                <span className="card-time mono">
                  {a.kind === "arrow" && <ArrowIcon />}
                  {formatTime(a.t)}
                </span>
              </div>
              <p className="card-text">{a.text}</p>
              {a.thread.map((m, i) => (
                <div key={i} className={`msg ${m.who}`}>
                  {m.who === "claude" ? (
                    <span className="claude-mark">C</span>
                  ) : (
                    <span
                      className="avatar tiny"
                      style={{ background: avatarColor(m.author ?? "") }}
                    >
                      {initials(m.author ?? "")}
                    </span>
                  )}
                  <div className="msg-body">
                    <span className="msg-name">
                      {m.who === "claude" ? "Claude Code" : m.author}
                    </span>
                    <p>{m.text}</p>
                  </div>
                </div>
              ))}
              {a.status === "sent" && (
                <div className="sent-note">
                  <span className="dot" />
                  <span>Sent</span>
                </div>
              )}
              {replying && (
                <div className="reply-row" onClick={(e) => e.stopPropagation()}>
                  <input
                    ref={replyRef}
                    className="field"
                    placeholder="Reply to Claude…"
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void sendReply(a);
                      if (e.key === "Escape") setReplyFor(null);
                    }}
                  />
                  <button className="btn btn-primary" onClick={() => void sendReply(a)}>
                    Reply
                  </button>
                </div>
              )}
              {(a.status === "open" || a.status === "replied") && !replying && (
                <div className="card-actions">
                  {a.status === "replied" && lastIsClaude && (
                    <button
                      className="link-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setReplyText("");
                        setReplyFor(a.id);
                      }}
                    >
                      Reply
                    </button>
                  )}
                  <button
                    className="btn btn-ghost-outline push-right resolve-btn"
                    title="Mark resolved"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onResolve(a);
                    }}
                  >
                    <CheckIcon className="accent" />
                    Resolve
                  </button>
                </div>
              )}
              {a.status === "resolved" && (
                <div className="card-actions">
                  <span className="resolved-tag">
                    <CheckIcon size={13} />
                    Resolved
                  </span>
                  <button
                    className="link-btn push-right"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onReopen(a);
                    }}
                  >
                    Reopen
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="panel-foot">
        <button
          className="send-btn"
          data-testid="send"
          onClick={props.onSend}
          disabled={!openTotal}
        >
          <SendIcon />
          {openTotal ? `Send ${openTotal}` : "Send"}
        </button>
      </div>
    </section>
  );
}
