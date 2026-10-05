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
}: {
  status: AgentStatus;
  withLabel?: boolean;
}) {
  return (
    <span
      className={`agent-badge ${status}`}
      data-status={status}
      title={withLabel ? undefined : LABELS[status]}
    >
      <span className="agent-dot" />
      {withLabel && LABELS[status]}
    </span>
  );
}
