import { useEffect, useRef, useState } from "react";
import type { Annotation } from "../../shared/types.ts";
import type { NoteEdit } from "../api.ts";
import { formatTime } from "../format.ts";
import { ArrowIcon, ArrowRightIcon, CheckIcon, PencilIcon, TrashIcon } from "./icons.tsx";
import { Markdown } from "./Linkify.tsx";
import { usePastedImages } from "../pastedImages.ts";
import { Thumbs } from "./PastedImages.tsx";
import { Avatar } from "./Avatar.tsx";

const REPLY_STATUS = { partial: "Partial", voice: "Needs voice", question: "Question" };

interface Props {
  annotations: Annotation[];
  activeId: number | null;
  showResolved: boolean;
  onToggleResolved: () => void;
  onSelect: (a: Annotation) => void;
  onResolve: (a: Annotation) => void;
  onReopen: (a: Annotation) => void;
  onReply: (a: Annotation, text: string, images: string[]) => Promise<void>;
  onEdit: (a: Annotation, change: NoteEdit) => Promise<void>;
  onDelete: (a: Annotation) => void;
  /** Open annotations across every video in the folder. */
  openTotal: number;
  onSend: () => void;
  onOpenPath: (path: string) => void;
}

export function AnnotationList(props: Props) {
  const { annotations, activeId, showResolved, openTotal } = props;
  const [replyFor, setReplyFor] = useState<number | null>(null);
  /** Questions whose reply box the reviewer closed. A question's box starts open. */
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  /** The text being edited: the note itself (message -1) or one of the reviewer's replies. */
  const [editing, setEditing] = useState<{ id: number; message: number } | null>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const unresolved = annotations.filter((a) => a.status !== "resolved");
  const resolvedCount = annotations.length - unresolved.length;
  const shown = annotations
    .filter((a) => a.status !== "resolved" || showResolved)
    .sort((a, b) => a.t - b.t);

  /** The reviewer's own words with an edit button, or the editor while they're being edited. */
  const humanBubble = (
    a: Annotation,
    message: number,
    text: string,
    images: string[] | undefined,
    author: string | undefined,
  ) =>
    editing?.id === a.id && editing.message === message ? (
      <NoteEditor
        key={message}
        initialText={text}
        saved={images}
        onOpenPath={props.onOpenPath}
        onCancel={() => setEditing(null)}
        onSave={async (newText, keep, pasted) => {
          await props.onEdit(a, {
            ...(message >= 0 ? { message } : {}),
            text: newText,
            keep,
            images: pasted,
          });
          setEditing(null);
        }}
      />
    ) : (
      <div key={message} className="chat-human" title={author}>
        <button
          className="mini-btn bubble-edit"
          title="Edit"
          onClick={(e) => {
            e.stopPropagation();
            setReplyFor(null);
            setEditing({ id: a.id, message });
          }}
        >
          <PencilIcon />
        </button>
        {text}
        <Thumbs saved={images} onOpen={props.onOpenPath} />
      </div>
    );

  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-title">TODOs</div>
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
        {!shown.length && (
          <p className="empty-hint">
            To add an item here, highlight text or click in a paused video.
          </p>
        )}
        {shown.map((a) => {
          const isActive = a.id === activeId;
          const last = a.thread.at(-1);
          const lastIsClaude = last?.who === "claude";
          const asked = a.status === "replied" && lastIsClaude && last?.replyStatus === "question";
          const replying =
            replyFor === a.id || (asked && !dismissed.has(a.id) && editing?.id !== a.id);
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
                <Avatar name={a.author} className="tiny" />
                <span className="card-author">{a.author}</span>
                {a.cut && (
                  <span
                    className="cut-tag"
                    title={
                      a.tOriginal !== undefined
                        ? `Its moment, at ${formatTime(a.tOriginal)}, was cut from a later render`
                        : undefined
                    }
                  >
                    Cut
                  </span>
                )}
                {a.kind !== "text" && (
                  <span className="card-time mono">
                    {a.kind === "arrow" && <ArrowIcon />}
                    {formatTime(a.t)}
                  </span>
                )}
                <button
                  className="mini-btn card-delete"
                  title="Delete"
                  data-testid={`delete-${a.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onDelete(a);
                  }}
                >
                  <TrashIcon />
                </button>
              </div>
              {a.quote && (
                <blockquote className="card-quote" title={a.quote.exact}>
                  {a.quote.exact}
                </blockquote>
              )}
              <div className="chat">
                {humanBubble(a, -1, a.text, a.images, a.author)}
                {a.thread.map((m, i) =>
                  m.who === "claude" ? (
                    <div key={i} className="chat-ai">
                      {m.replyStatus && m.replyStatus !== "done" && (
                        <span className={`reply-status ${m.replyStatus}`}>
                          {REPLY_STATUS[m.replyStatus]}
                        </span>
                      )}
                      <Markdown text={m.text} onOpenPath={props.onOpenPath} />
                    </div>
                  ) : (
                    humanBubble(a, i, m.text, m.images, m.author)
                  ),
                )}
              </div>
              {a.status === "sent" && (
                <div className="sent-note">
                  <span className="dot" />
                  <span>Sent</span>
                </div>
              )}
              {replying && (
                <NoteEditor
                  placeholder="Reply to Claude…"
                  saveLabel="Reply"
                  autoFocus={replyFor === a.id || isActive}
                  onOpenPath={props.onOpenPath}
                  onCancel={() => {
                    setReplyFor(null);
                    setDismissed((d) => new Set(d).add(a.id));
                  }}
                  onSave={async (text, _keep, pasted) => {
                    await props.onReply(a, text, pasted);
                    setReplyFor(null);
                  }}
                />
              )}
              {(a.status === "open" || a.status === "replied") && !replying && (
                <div className="card-actions">
                  {a.status === "replied" && lastIsClaude && (
                    <button
                      className="link-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(null);
                        setReplyFor(a.id);
                      }}
                    >
                      Reply
                    </button>
                  )}
                  <button
                    className="btn btn-ghost-outline push-right resolve-btn"
                    title="Mark resolved"
                    disabled={!a.thread.some((m) => m.who === "claude")}
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
          {openTotal ? `Send ${openTotal} to Claude` : "Send to Claude"}
          <ArrowRightIcon className="send-arrow" />
        </button>
      </div>
    </section>
  );
}

/** A text box for a reply or an edit, which takes pasted images too. */
function NoteEditor({
  initialText = "",
  saved = [],
  placeholder,
  saveLabel = "Save",
  autoFocus = true,
  onSave,
  onCancel,
  onOpenPath,
}: {
  initialText?: string;
  saved?: string[];
  placeholder?: string;
  saveLabel?: string;
  autoFocus?: boolean;
  /** The text, the saved images still kept, and the newly pasted ones. */
  onSave: (text: string, keep: string[], pasted: string[]) => Promise<void>;
  onCancel: () => void;
  onOpenPath: (path: string) => void;
}) {
  const [text, setText] = useState(initialText);
  const [keep, setKeep] = useState(saved);
  const [busy, setBusy] = useState(false);
  const pasted = usePastedImages();
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const box = ref.current;
    if (!box || !autoFocus) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, [autoFocus]);

  const empty = !text.trim() && !keep.length && !pasted.images.length;
  const save = async () => {
    if (empty || busy) return;
    setBusy(true);
    try {
      await onSave(text, keep, pasted.images);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="note-editor" onClick={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        className="field"
        rows={Math.min(8, Math.max(2, text.split("\n").length))}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={pasted.onPaste}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void save();
          }
          if (e.key === "Escape") onCancel();
        }}
      />
      <Thumbs
        saved={keep}
        pasted={pasted.images}
        onOpen={onOpenPath}
        onRemove={(img) => {
          if (keep.includes(img)) setKeep(keep.filter((k) => k !== img));
          else pasted.remove(img);
        }}
      />
      <div className="draft-actions">
        <button className="btn btn-ghost-outline push-right" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={empty || busy} onClick={() => void save()}>
          {saveLabel}
        </button>
      </div>
    </div>
  );
}
