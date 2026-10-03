import { useEffect, useState } from "react";
import type { AgentState, UsageWindow } from "../../shared/types.ts";
import { modelName } from "../format.ts";

/** The newest model of each family, by full name, so a session stays on that version. */
const MODELS = [
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-4-5-20251001",
];

const EFFORTS = [
  ["", "Default effort"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Max"],
] as const;

interface Props {
  state: AgentState | null;
  model: string;
  effort: string;
  onModel: (model: string) => void;
  onEffort: (effort: string) => void;
  onCompact: () => void;
}

/** Model and effort pickers, how full the context is, and the account's usage limits. */
export function SessionMeter({ state, model, effort, onModel, onEffort, onCompact }: Props) {
  // Re-render each minute so the countdowns stay current.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const contextFraction =
    state?.contextTokens !== undefined && state.contextWindow
      ? state.contextTokens / state.contextWindow
      : undefined;
  const context = contextFraction !== undefined ? `${Math.round(contextFraction * 100)}%` : "–";
  // Compacting needs a conversation, and waits for any turn in progress.
  const canCompact = Boolean(state?.sessionId) && state?.status !== "working";

  return (
    <div className="meter" data-testid="session-meter">
      <select
        className="meter-select"
        aria-label="Model"
        title={state?.model}
        value={model}
        onChange={(e) => onModel(e.target.value)}
      >
        <option value="">
          {state?.model && !model ? `Default · ${modelName(state.model)}` : "Default model"}
        </option>
        {[...MODELS, ...(model && !MODELS.includes(model) ? [model] : [])].map((id) => (
          <option key={id} value={id}>
            {modelName(id)}
          </option>
        ))}
      </select>
      <select
        className="meter-select"
        aria-label="Effort"
        value={effort}
        onChange={(e) => onEffort(e.target.value)}
      >
        {EFFORTS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <span
        className={`meter-context${canCompact ? " can-compact" : ""}`}
        data-testid="meter-context"
      >
        <span
          className={`meter-item meter-context-label${contextFraction !== undefined && contextFraction > 0.5 ? " over" : ""}`}
        >
          Context {context}
        </span>
        {canCompact && (
          <button className="meter-compact" onClick={onCompact}>
            Compact
          </button>
        )}
      </span>
      <Limit label="5h" window={state?.limits?.fiveHour} now={now} testId="meter-5h" />
      <Limit label="Week" window={state?.limits?.sevenDay} now={now} testId="meter-week" />
    </div>
  );
}

function Limit(props: { label: string; window?: UsageWindow; now: number; testId: string }) {
  const { label, window: w, now, testId } = props;
  if (!w) {
    return (
      <span className="meter-item" data-testid={testId}>
        {label} –
      </span>
    );
  }
  const resets = new Date(w.resetsAt * 1000);
  return (
    <span
      className={`meter-item${w.utilization > 0.8 ? " over" : ""}`}
      data-testid={testId}
      title={`Resets ${resets.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`}
    >
      {label} {Math.round(w.utilization * 100)}% · {untilReset(resets.getTime() - now)}
    </span>
  );
}

/** 2h 10m, or 3d 4h when a day or more away. */
function untilReset(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h ${minutes % 60}m`;
}
