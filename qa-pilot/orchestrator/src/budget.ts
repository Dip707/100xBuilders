import type { RunState } from "./state.js";

export function budgetExceeded(state: RunState): string | null {
  if (state.llmCalls > state.budget.maxLlmCalls) return `llm calls ${state.llmCalls} > ${state.budget.maxLlmCalls}`;
  const minutes = (Date.now() - Date.parse(state.startedAt)) / 60_000;
  if (minutes > state.budget.maxMinutes) return `minutes ${minutes.toFixed(1)} > ${state.budget.maxMinutes}`;
  return null;
}
