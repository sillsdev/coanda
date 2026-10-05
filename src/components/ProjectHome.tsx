// A project's own page: its planning documents in order, each started, opened and approved
// here. A step can start once the one before it is approved.
import type { PlanningStep } from "../../shared/types.ts";
import { CheckIcon } from "./icons.tsx";

interface Props {
  project: string;
  steps: PlanningStep[];
  onStart: (step: PlanningStep) => void;
  onOpen: (step: PlanningStep) => void;
  /** When the draft video was asked for, or null. */
  draftRequested: string | null;
  /** The video made for the draft step, once there is one. */
  draftVideo: string | null;
  onOpenDraft: (video: string) => void;
  onMakeDraft: () => void;
}

function stepState(step: PlanningStep): { label: string; className: string } {
  if (!step.started) return { label: "Not started", className: "todo" };
  if (step.approved && !step.changedSinceApproval) return { label: "Approved", className: "done" };
  if (step.approved) return { label: "Changed since approved", className: "changed" };
  return { label: "Draft", className: "draft" };
}

export function ProjectHome({
  project,
  steps,
  onStart,
  onOpen,
  draftRequested,
  draftVideo,
  onOpenDraft,
  onMakeDraft,
}: Props) {
  const last = steps.at(-1);
  const scriptApproved = last?.approved !== undefined && !last.changedSinceApproval;
  return (
    <main className="player project-home" data-testid="project-home">
      <h1 className="project-home-title">{project.split("/").pop() || project}</h1>
      <ol className="steps">
        {steps.map((step, i) => {
          const state = stepState(step);
          const before = steps[i - 1];
          const ready = !before || (before.approved !== undefined && !before.changedSinceApproval);
          return (
            <li
              key={step.key}
              className={`step step-${state.className}`}
              data-testid={`step-${step.key}`}
            >
              <span className="step-num">
                {state.className === "done" ? <CheckIcon size={13} /> : i + 1}
              </span>
              <span className="step-title">{step.title}</span>
              <span className="step-state">{state.label}</span>
              {step.unresolved > 0 && <span className="count-badge">{step.unresolved}</span>}
              {step.started ? (
                <button className="btn btn-ghost-outline push-right" onClick={() => onOpen(step)}>
                  Open
                </button>
              ) : (
                <button
                  className="btn btn-primary push-right"
                  disabled={!ready}
                  onClick={() => onStart(step)}
                >
                  Start
                </button>
              )}
            </li>
          );
        })}
        {steps.length > 0 && (
          <li
            className={`step ${draftRequested ? "step-done" : "step-todo"}`}
            data-testid="step-draft"
          >
            <span className="step-num">
              {draftRequested ? <CheckIcon size={13} /> : steps.length + 1}
            </span>
            <span className="step-title">Draft video</span>
            <span className="step-state">
              {draftVideo ? "Made" : draftRequested ? "Asked for" : "Not started"}
            </span>
            {draftVideo && (
              <button
                className="btn btn-ghost-outline push-right"
                onClick={() => onOpenDraft(draftVideo)}
              >
                Open
              </button>
            )}
            {!draftRequested && (
              <button
                className="btn btn-primary push-right"
                disabled={!scriptApproved}
                onClick={onMakeDraft}
              >
                Make
              </button>
            )}
          </li>
        )}
      </ol>
    </main>
  );
}
