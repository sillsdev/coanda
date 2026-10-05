import { useEffect, useRef, useState } from "react";
import type { AgentMessage, AgentQuestion, AgentState, ClaudeAuth } from "../../shared/types.ts";
import { usePastedImages } from "../pastedImages.ts";
import { AgentStatusBadge } from "./AgentStatusBadge.tsx";
import { ChevronIcon, SendIcon } from "./icons.tsx";
import { Linkify, Markdown } from "./Linkify.tsx";
import { Thumbs } from "./PastedImages.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { SessionMeter } from "./SessionMeter.tsx";

interface Props {
  /** The project's folder; null when the selection is in no project; undefined while unknown. */
  project: string | null | undefined;
  /** Claude's questions, shown in the chat where Claude asked them. */
  questions: AgentQuestion[];
  onAnswer: (q: AgentQuestion, text: string) => void;
  onDeleteQuestion: (q: AgentQuestion) => void;
  onMakeProject: () => void;
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
  // Runs of tool calls the reviewer opened or closed, by the index of their first call.
  const [toolsOpen, setToolsOpen] = useState<Map<number, boolean>>(new Map());
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
        <div className="panel-head" />
      </section>
    );
  }

  if (project === null) {
    return (
      <section className="panel agent-panel" data-testid="agent-panel">
        <div className="panel-head" />
        <div className="agent-none">
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
        <div className="panel-title agent-project" title={project || "/"}>
          {project.split("/").pop() || "/"}
        </div>
      </div>
      {auth && !auth.loggedIn ? (
        <div className="agent-login">
          {auth.installed ? (
            <button className="btn btn-primary" onClick={onLogin}>
              Log in to Claude
            </button>
          ) : (
            <a
              className="btn btn-primary"
              href="https://claude.com/claude-code"
              target="_blank"
              rel="noreferrer"
            >
              Install Claude Code
            </a>
          )}
        </div>
      ) : (
        <>
          <div className="agent-log" ref={listRef} data-testid="agent-log">
            {groupTools(state?.messages ?? [], props.questions).map((g, i, all) =>
              g.question ? (
                <QuestionCard
                  key={`q${g.question.id}`}
                  question={g.question}
                  onAnswer={(text) => props.onAnswer(g.question, text)}
                  onDelete={() => props.onDeleteQuestion(g.question)}
                  onOpenPath={props.onOpenPath}
                />
              ) : g.tools ? (
                <ToolRun
                  key={g.start}
                  tools={g.tools}
                  latest={i === all.length - 1}
                  open={toolsOpen.get(g.start)}
                  onToggle={(open) => setToolsOpen((prev) => new Map(prev).set(g.start, open))}
                  onOpenPath={props.onOpenPath}
                />
              ) : (
                <div
                  key={g.start}
                  className={`agent-msg ${g.message.role}${g.message.role === "user" ? " chat-human" : g.message.role === "assistant" ? " chat-ai" : ""}`}
                >
                  {g.message.role === "assistant" ? (
                    <Markdown text={g.message.text} onOpenPath={props.onOpenPath} />
                  ) : (
                    <Linkify text={g.message.text} onOpenPath={props.onOpenPath} />
                  )}
                  {g.message.images && (
                    <Thumbs saved={g.message.images} onOpen={props.onOpenPath} />
                  )}
                </div>
              ),
            )}
          </div>
          <div className="agent-status">
            <AgentStatusBadge
              status={status}
              compacting={state?.compacting}
              waiting={!!state?.background?.length}
            />
            {status === "working" && state?.workingSince && <Elapsed since={state.workingSince} />}
            {status !== "working" && !!state?.background?.length && (
              <span className="agent-background" title={state.background.join("\n")}>
                {state.background.join(" · ")}
              </span>
            )}
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

type Group =
  | { start: number; tools: AgentMessage[]; message?: undefined; question?: undefined }
  | { start: number; message: AgentMessage; tools?: undefined; question?: undefined }
  | { start: number; question: AgentQuestion; tools?: undefined; message?: undefined };

/** The messages, with each run of consecutive tool calls gathered into one group, and each of
 * Claude's questions placed where it was asked. */
function groupTools(messages: AgentMessage[], questions: AgentQuestion[]): Group[] {
  const groups: Group[] = [];
  const waiting = [...questions].sort((a, b) => a.askedAt.localeCompare(b.askedAt));
  const askBefore = (at: string | undefined) => {
    while (waiting.length && (at === undefined || waiting[0].askedAt <= at)) {
      const question = waiting.shift()!;
      groups.push({ start: -question.id, question });
    }
  };
  messages.forEach((m, i) => {
    askBefore(m.at);
    const last = groups[groups.length - 1];
    if (m.role !== "tool") groups.push({ start: i, message: m });
    else if (last?.tools) last.tools.push(m);
    else groups.push({ start: i, tools: [m] });
  });
  askBefore(undefined);
  return groups;
}

/** A run of tool calls: open while it's the latest thing in the chat, closed once Claude says
 * something after it, unless the reviewer opened or closed it. */
function ToolRun(props: {
  tools: AgentMessage[];
  latest: boolean;
  open: boolean | undefined;
  onToggle: (open: boolean) => void;
  onOpenPath: (path: string) => void;
}) {
  const open = props.open ?? props.latest;
  return (
    <div className="agent-tools">
      <button
        className="agent-tools-toggle"
        aria-expanded={open}
        onClick={() => props.onToggle(!open)}
      >
        <ChevronIcon size={12} open={open} />
        {props.tools.length} {props.tools.length === 1 ? "tool call" : "tool calls"}
      </button>
      {open &&
        props.tools.map((m, i) => (
          <div key={i} className="agent-msg tool">
            <Linkify text={m.text} onOpenPath={props.onOpenPath} />
          </div>
        ))}
    </div>
  );
}
