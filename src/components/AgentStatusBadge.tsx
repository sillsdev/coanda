import type { AgentStatus } from "../../shared/types.ts";

const LABELS: Record<AgentStatus, string> = {
  idle: "Idle",
  working: "Working",
  done: "Done",
  question: "Question",
  error: "Error",
};

/** A small dot, with a label when `withLabel`, showing a Claude session's status. */
export function AgentStatusBadge({
  status,
  withLabel = true,
  compacting = false,
}: {
  status: AgentStatus;
  withLabel?: boolean;
  /** Working on Claude Code's /compact. */
  compacting?: boolean;
}) {
  const label = status === "working" && compacting ? "Compacting" : LABELS[status];
  return (
    <span
      className={`agent-badge ${status}`}
      data-status={status}
      title={withLabel ? undefined : label}
    >
      <span className="agent-dot">{status === "question" && "?"}</span>
      {withLabel && label}
    </span>
  );
}
