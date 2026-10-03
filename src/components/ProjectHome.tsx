// A project's own page: its planning documents in order, each started, opened and approved
// here. A step can start once the one before it is approved.
import type { PlanningStep } from "../../shared/types.ts";
import { CheckIcon } from "./icons.tsx";

interface Props {
  project: string;
  steps: PlanningStep[];
  onStart: (step: PlanningStep) => void;
  onOpen: (step: PlanningStep) => void;
}

function stepState(step: PlanningStep): { label: string; className: string } {
  if (!step.exists) return { label: "Not started", className: "todo" };
  if (step.approved && !step.changedSinceApproval) return { label: "Approved", className: "done" };
  if (step.approved) return { label: "Changed since approved", className: "changed" };
  return { label: "Draft", className: "draft" };
}

export function ProjectHome({ project, steps, onStart, onOpen }: Props) {
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
              {step.exists ? (
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
      </ol>
    </main>
  );
}
