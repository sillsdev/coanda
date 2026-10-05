// A Markdown document in the middle column: read it and comment on passages, or edit it.
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type MouseEvent,
  type Ref,
} from "react";
import type { Annotation, DocText, PlanningStep } from "../../shared/types.ts";
import { api, mediaUrl, type NewAnnotation } from "../api.ts";
import { usePastedImages } from "../pastedImages.ts";
import { findQuote, quoteAt, rangeAt, rangeOffsets } from "../textQuote.ts";
import { CheckIcon, CommentIcon } from "./icons.tsx";
import { Markdown } from "./Linkify.tsx";
import { Thumbs } from "./PastedImages.tsx";
import { Avatar } from "./Avatar.tsx";

/** How long typing pauses before an edit is saved. */
const SAVE_AFTER_MS = 700;

export interface DocViewHandle {
  /** Shows a comment's passage. */
  reveal: (a: Annotation) => void;
}

interface Props {
  path: string;
  /** Changes whenever the document changes on disk. */
  version: number;
  annotations: Annotation[];
  activeId: number | null;
  showResolved: boolean;
  me: string;
  ref?: Ref<DocViewHandle>;
  onSelect: (a: Annotation) => void;
  onDeselect: () => void;
  onCreate: (a: NewAnnotation) => Promise<void>;
  onOpenPath: (path: string) => void;
  onError: (message: string) => void;
  /** When the document is one of the project's planning steps. */
  step?: PlanningStep;
  onApprove?: (approved: boolean) => void;
  /** The step after this one, offered once this one is approved. */
  nextStep?: PlanningStep;
  onNextStep?: (step: PlanningStep) => void;
  /** The last planning document, after which comes the draft video. */
  isLastStep?: boolean;
  draftRequested?: string | null;
  onMakeDraft?: () => void;
}

interface Draft {
  quote: NewAnnotation["quote"];
  start: number;
  /** Where the comment box goes, in pixels within the scrolling page. */
  left: number;
  top: number;
  /** False while only the Comment button shows. */
  open: boolean;
  text: string;
}

export function DocView(props: Props) {
  const { path, version, annotations, activeId, showResolved, me, ref, onError } = props;
  const { onSelect, onDeselect, onCreate, onOpenPath, step, onApprove } = props;
  const { nextStep, onNextStep, isLastStep, draftRequested, onMakeDraft } = props;
  const approved = step?.approved !== undefined && !step.changedSinceApproval;
  const [doc, setDoc] = useState<DocText | null>(null);
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [text, setText] = useState("");
  const [conflict, setConflict] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const pasted = usePastedImages();
  const pageRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  // The text as last saved or loaded, to tell unsaved typing from the file's own text.
  const savedRef = useRef<DocText | null>(null);
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);
  const conflictRef = useRef(conflict);
  useEffect(() => {
    conflictRef.current = conflict;
  }, [conflict]);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // A write is on its way; another waits for it, so each is based on the one before.
  const writingRef = useRef(false);
  // The file changed on disk during a write, to be read again once the write is done.
  const loadAfterWriteRef = useRef(false);

  /** Reads the document from disk, keeping unsaved typing. */
  const load = useCallback(() => {
    const apply = (d: DocText) => {
      if (!mountedRef.current) return;
      if (writingRef.current) {
        loadAfterWriteRef.current = true;
        return;
      }
      const saved = savedRef.current;
      // The text last saved or loaded, perhaps with typing since: nothing new on disk.
      if (saved && d.text === saved.text) {
        savedRef.current = d;
        return;
      }
      const dirty = saved !== null && textRef.current !== saved.text;
      if (dirty && d.text !== textRef.current) {
        setConflict(true);
        return;
      }
      savedRef.current = d;
      setDoc(d);
      setText(d.text);
      setConflict(false);
    };
    api.doc(path).then(
      apply,
      // A document deleted or renamed while open just goes; the sidebar shows what's there now.
      (e: Error) => !/^No document/.test(e.message) && onError(e.message),
    );
  }, [path, onError]);

  /** Writes the typing to disk until the file has the latest of it, one write at a time. */
  const save = useCallback(async () => {
    if (writingRef.current) return;
    writingRef.current = true;
    try {
      for (;;) {
        const saved = savedRef.current;
        const latest = textRef.current;
        if (!saved || conflictRef.current || latest === saved.text) break;
        try {
          const d = await api.saveDoc(path, latest, saved.mtime);
          savedRef.current = d;
          if (mountedRef.current) setDoc(d);
        } catch (e) {
          const message = (e as Error).message;
          if (/changed on disk/i.test(message)) {
            conflictRef.current = true;
            if (mountedRef.current) setConflict(true);
          } else if (!/^No document/.test(message)) onError(message);
          break;
        }
      }
    } finally {
      writingRef.current = false;
    }
    if (loadAfterWriteRef.current) {
      loadAfterWriteRef.current = false;
      load();
    }
  }, [path, onError, load]);

  // Load the document, and again when it changes on disk.
  useEffect(() => {
    load();
  }, [load, version]);

  // Save typing once it pauses.
  useEffect(() => {
    const saved = savedRef.current;
    if (!saved || text === saved.text || conflict) return;
    const timer = setTimeout(() => void save(), SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [text, conflict, save]);

  // Leaving the document saves typing that has not waited out its pause yet.
  useEffect(() => () => void save(), [save]);

  const reload = () => {
    savedRef.current = null;
    conflictRef.current = false;
    setConflict(false);
    api.doc(path).then(
      (d) => {
        savedRef.current = d;
        setDoc(d);
        setText(d.text);
      },
      (e: Error) => onError(e.message),
    );
  };

  const shown = annotations.filter(
    (a) => a.kind === "text" && a.quote && (a.status !== "resolved" || showResolved),
  );

  /** Each shown comment's passage on the page, as it reads now. */
  const passages = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return [];
    const all = body.textContent ?? "";
    return shown.flatMap((a) => {
      const at = findQuote(all, a.quote!);
      const range = at && rangeAt(body, at.start, at.end);
      return range ? [{ a, range }] : [];
    });
  }, [shown]);

  // Mark the commented passages, without changing the page itself (CSS Custom Highlights).
  useLayoutEffect(() => {
    if (mode !== "read" || typeof CSS === "undefined" || !("highlights" in CSS)) return;
    const found = passages();
    // The passage a comment is being written on stays marked while the box has the focus.
    const body = bodyRef.current;
    const writing = draft?.open && body ? findQuote(body.textContent ?? "", draft.quote!) : null;
    const writingRange = writing && body ? rangeAt(body, writing.start, writing.end) : null;
    CSS.highlights.set(
      "howreel-comment",
      new Highlight(...found.filter((p) => p.a.id !== activeId).map((p) => p.range)),
    );
    CSS.highlights.set(
      "howreel-comment-active",
      new Highlight(
        ...found.filter((p) => p.a.id === activeId).map((p) => p.range),
        ...(writingRange ? [writingRange] : []),
      ),
    );
    return () => {
      CSS.highlights.delete("howreel-comment");
      CSS.highlights.delete("howreel-comment-active");
    };
  }, [mode, doc, passages, activeId, draft?.open, draft?.quote]);

  useImperativeHandle(
    ref,
    () => ({
      reveal: (a: Annotation) => {
        setMode("read");
        // After the page is showing.
        requestAnimationFrame(() => {
          const found = passages().find((p) => p.a.id === a.id);
          const el = found?.range.startContainer.parentElement;
          el?.scrollIntoView({ block: "center", behavior: "smooth" });
        });
      },
    }),
    [passages],
  );

  // Whenever text on the page is selected, however it was selected (dragging, double-clicking,
  // the keyboard), offer to comment on it with a button in the margin beside it.
  useEffect(() => {
    if (mode !== "read") return;
    const offer = (): Draft | null => {
      const body = bodyRef.current;
      const page = pageRef.current;
      const sel = getSelection();
      if (!body || !page || !sel || sel.isCollapsed || !sel.rangeCount) return null;
      // The part of the selection inside the document: a drag can run on past its end.
      const range = sel.getRangeAt(0).cloneRange();
      if (!range.intersectsNode(body)) return null;
      const whole = document.createRange();
      whole.selectNodeContents(body);
      if (range.compareBoundaryPoints(Range.START_TO_START, whole) < 0) {
        range.setStart(whole.startContainer, whole.startOffset);
      }
      if (range.compareBoundaryPoints(Range.END_TO_END, whole) > 0) {
        range.setEnd(whole.endContainer, whole.endOffset);
      }
      if (range.collapsed) return null;
      const all = body.textContent ?? "";
      const { start, end } = rangeOffsets(body, range);
      if (!all.slice(start, end).trim()) return null;
      const pageRect = page.getBoundingClientRect();
      const column = (body.firstElementChild ?? body).getBoundingClientRect();
      return {
        quote: quoteAt(all, start, end),
        start,
        left: column.right - pageRect.left + 10,
        top: range.getBoundingClientRect().top - pageRect.top + page.scrollTop,
        open: false,
        // Comments are addressed to Claude unless the reviewer says otherwise.
        text: "@Claude ",
      };
    };
    const onChange = () => setDraft((prev) => (prev?.open ? prev : offer()));
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [mode]);

  /** A click on a commented passage selects its comment. */
  const onPageClick = (e: MouseEvent) => {
    if (draft || !getSelection()?.isCollapsed) return;
    const caret = document.caretPositionFromPoint?.(e.clientX, e.clientY);
    if (!caret) return;
    const hit = passages().find((p) => p.range.isPointInRange(caret.offsetNode, caret.offset));
    if (hit) onSelect(hit.a);
    else onDeselect();
  };

  const draftEmpty = !draft?.text.replace(/^@Claude\s*/, "").trim() && !pasted.images.length;

  const saveDraft = async () => {
    if (!draft?.quote || saving || draftEmpty) return;
    setSaving(true);
    try {
      await onCreate({
        kind: "text",
        quote: draft.quote,
        t: draft.start,
        x: 0,
        y: 0,
        text: draft.text,
        images: pasted.images,
      });
      setDraft(null);
      pasted.clear();
      getSelection()?.removeAllRanges();
    } catch {
      // The draft stays open to try again; onCreate shows the error.
    } finally {
      setSaving(false);
    }
  };

  /** Pasting an image while editing saves it beside the document and links it in. */
  const onEditPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.items)
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null);
    if (!files.length) return;
    e.preventDefault();
    const box = e.currentTarget;
    const at = box.selectionStart;
    const end = box.selectionEnd;
    void Promise.all(files.map(readAsDataUrl))
      .then((urls) => Promise.all(urls.map((u) => api.docImage(path, u))))
      .then((saved) => {
        const links = saved.map((s) => `![](${s.path})`).join("\n");
        const current = textRef.current;
        setText(current.slice(0, at) + links + current.slice(end));
      })
      .catch((err: Error) => onError(err.message));
  };

  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";

  return (
    <main className="player doc-view" data-testid="doc-view">
      <div className="title-row">
        {conflict && (
          <>
            <span className="doc-conflict">Changed on disk</span>
            <button className="btn btn-ghost-outline" onClick={reload}>
              Reload
            </button>
          </>
        )}
        {step && onApprove && (
          <button
            className={`btn approve-btn${approved ? " on" : ""}`}
            data-testid="approve"
            aria-pressed={approved}
            onClick={() => onApprove(!approved)}
          >
            <CheckIcon size={13} />
            {approved ? "Approved" : "Approve"}
          </button>
        )}
        {approved && isLastStep && onMakeDraft && !draftRequested && (
          <button className="btn btn-primary" data-testid="next-step" onClick={onMakeDraft}>
            Make draft video
          </button>
        )}
        {approved && nextStep && onNextStep && (
          <button
            className="btn btn-primary"
            data-testid="next-step"
            onClick={() => onNextStep(nextStep)}
          >
            {nextStep.started ? "Open" : "Start"} {nextStep.title.toLowerCase()}
          </button>
        )}
        <div className="segmented" role="group">
          <button
            className={mode === "read" ? "on" : undefined}
            aria-pressed={mode === "read"}
            onClick={() => setMode("read")}
          >
            Read
          </button>
          <button
            className={mode === "edit" ? "on" : undefined}
            aria-pressed={mode === "edit"}
            data-testid="doc-edit"
            onClick={() => {
              setDraft(null);
              setMode("edit");
              setTimeout(() => editRef.current?.focus(), 0);
            }}
          >
            Edit
          </button>
        </div>
      </div>
      {mode === "edit" ? (
        <textarea
          ref={editRef}
          className="doc-editor field mono"
          data-testid="doc-editor"
          value={text}
          spellCheck
          onChange={(e) => setText(e.target.value)}
          onPaste={onEditPaste}
        />
      ) : (
        <div ref={pageRef} className="doc-page" data-testid="doc-page" onClick={onPageClick}>
          <div ref={bodyRef}>
            <Markdown
              text={doc?.text ?? ""}
              onOpenPath={onOpenPath}
              imageUrl={(src) => mediaUrl(dir + src, doc?.mtime)}
              className="md doc-md"
            />
          </div>
          {draft && !draft.open && (
            <button
              className="doc-comment-btn"
              data-testid="doc-comment"
              title="Comment"
              aria-label="Comment"
              style={{ left: draft.left, top: draft.top }}
              // Keep the selection while the button is pressed.
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                setDraft({ ...draft, open: true });
                setTimeout(() => {
                  const box = draftRef.current;
                  box?.focus();
                  box?.setSelectionRange(box.value.length, box.value.length);
                }, 0);
              }}
            >
              <CommentIcon />
            </button>
          )}
          {draft?.open && (
            <div
              className="draft doc-draft"
              data-testid="draft"
              style={{ left: Math.max(8, draft.left + 34 - 300), top: draft.top + 36 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="draft-head">
                <Avatar name={me} className="small" />
                <span className="draft-name">{me}</span>
              </div>
              <textarea
                ref={draftRef}
                className="field"
                rows={3}
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
                <button
                  className="btn btn-ghost-outline push-right"
                  onClick={() => {
                    setDraft(null);
                    pasted.clear();
                  }}
                >
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
      )}
    </main>
  );
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
    reader.readAsDataURL(file);
  });
}
