import { useState } from "react";
import type { AgentQuestion } from "../../shared/types.ts";
import { TrashIcon } from "./icons.tsx";
import { Markdown } from "./Linkify.tsx";

/** One of Claude's questions in the chat, with its suggested answers as buttons and a box for
 * another. Once answered, the answer follows it in the chat. */
export function QuestionCard({
  question,
  onAnswer,
  onDelete,
  onOpenPath,
}: {
  question: AgentQuestion;
  onAnswer: (text: string) => void;
  onDelete: () => void;
  onOpenPath: (path: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <div
      className={`card question-card${question.answer ? " answered" : ""}`}
      data-testid={`question-${question.id}`}
    >
      <button className="mini-btn card-delete question-delete" title="Delete" onClick={onDelete}>
        <TrashIcon />
      </button>
      <div className="chat">
        <div className="chat-ai">
          <Markdown text={question.text} onOpenPath={onOpenPath} />
        </div>
        {!question.answer && (
          <>
            {question.options.length > 0 && (
              <div className="question-options">
                {question.options.map((o) => (
                  <button key={o} className="btn question-option" onClick={() => onAnswer(o)}>
                    {o}
                  </button>
                ))}
              </div>
            )}
            <div className="reply-row">
              <input
                className="field"
                placeholder="Answer…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && text.trim()) onAnswer(text);
                }}
              />
              <button
                className="btn btn-primary"
                disabled={!text.trim()}
                onClick={() => onAnswer(text)}
              >
                Answer
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
