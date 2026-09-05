import type { NewRunInput } from "./api";

/**
 * Everything the Start-a-run screen holds. The chat writes into it through `applyPatch` and
 * the person types into it directly; both go through the same object so the form is the one
 * source of truth for what the run will be.
 */
export type RunDraft = {
  url: string;
  intent: string;
  prdText: string;
  prdName: string;
  requiresSignIn: boolean;
  /** Target-app credentials. Held here for the length of the visit and sent only with the run. */
  username: string;
  password: string;
  reviewPlan: boolean;
  maxFlows: number;
  budget: { maxLlmCalls: number; maxMinutes: number };
};

/**
 * How many flows a new run plans by default. Mirrors the orchestrator's own default
 * (`DEFAULT_MAX_FLOWS` in `state.ts`), which is what a run actually uses when the form
 * does not send one; the two are kept in step by hand because the UI and the orchestrator
 * share no package.
 *
 * Three, not a dozen: the plan is written in one LLM call whose length scales with the
 * number of flows, and it is the longest wait in a run.
 */
export const DEFAULT_MAX_FLOWS = 3;

export const DEFAULT_DRAFT: RunDraft = {
  url: "", intent: "", prdText: "", prdName: "",
  requiresSignIn: false, username: "", password: "",
  reviewPlan: false, maxFlows: DEFAULT_MAX_FLOWS, budget: { maxLlmCalls: 200, maxMinutes: 40 },
};

/** The fields a chat turn may write. Mirrors the server's patch shape. */
export type DraftPatch = {
  url?: string;
  intent?: string;
  prdText?: string;
  prdName?: string;
  requiresSignIn?: boolean;
  reviewPlan?: boolean;
  maxFlows?: number;
  budget?: { maxLlmCalls?: number; maxMinutes?: number };
};

/** Names used both for the flash highlight and for the "filled in X" line under a reply. */
export type DraftField = "url" | "intent" | "prd" | "requiresSignIn" | "reviewPlan" | "maxFlows" | "budget";

export function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Sign-in off means no credentials, wherever the change came from. Otherwise a username and
 * password typed earlier would still travel with the run while the inputs holding them are
 * off screen.
 */
function withCredentialRule(draft: RunDraft): RunDraft {
  return draft.requiresSignIn ? draft : { ...draft, username: "", password: "" };
}

export function applyPatch(draft: RunDraft, patch: DraftPatch): RunDraft {
  const next: RunDraft = {
    ...draft,
    ...(patch.url !== undefined ? { url: patch.url } : {}),
    ...(patch.intent !== undefined ? { intent: patch.intent } : {}),
    ...(patch.prdText !== undefined ? { prdText: patch.prdText } : {}),
    ...(patch.prdName !== undefined ? { prdName: patch.prdName } : {}),
    ...(patch.requiresSignIn !== undefined ? { requiresSignIn: patch.requiresSignIn } : {}),
    ...(patch.reviewPlan !== undefined ? { reviewPlan: patch.reviewPlan } : {}),
    ...(patch.maxFlows !== undefined ? { maxFlows: patch.maxFlows } : {}),
    // Merged rather than replaced: a turn that changes the time budget should not silently
    // reset the call budget to whatever the model happened to omit.
    ...(patch.budget ? { budget: { ...draft.budget, ...patch.budget } } : {}),
  };
  return withCredentialRule(next);
}

/** Which named fields differ between two drafts, so the form flashes only what moved. */
export function changedFields(before: RunDraft, after: RunDraft): DraftField[] {
  const changed: DraftField[] = [];
  if (before.url !== after.url) changed.push("url");
  if (before.intent !== after.intent) changed.push("intent");
  if (before.prdText !== after.prdText || before.prdName !== after.prdName) changed.push("prd");
  if (before.requiresSignIn !== after.requiresSignIn) changed.push("requiresSignIn");
  if (before.reviewPlan !== after.reviewPlan) changed.push("reviewPlan");
  if (before.maxFlows !== after.maxFlows) changed.push("maxFlows");
  if (before.budget.maxLlmCalls !== after.budget.maxLlmCalls || before.budget.maxMinutes !== after.budget.maxMinutes) changed.push("budget");
  return changed;
}

/**
 * The form as the assistant is allowed to see it. Built by naming each field rather than by
 * spreading the draft, so the credentials cannot travel to the API, into a prompt, or into a
 * stored transcript - the sign-in flag goes, the account does not.
 */
export function snapshotOf(draft: RunDraft): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    requiresSignIn: draft.requiresSignIn,
    reviewPlan: draft.reviewPlan,
    maxFlows: draft.maxFlows,
    budget: draft.budget,
  };
  if (draft.url.trim()) snapshot.url = draft.url.trim();
  if (draft.intent.trim()) snapshot.intent = draft.intent.trim();
  if (draft.prdText) snapshot.prdText = draft.prdText;
  if (draft.prdName) snapshot.prdName = draft.prdName;
  return snapshot;
}

/** The body of `POST /run`. Blank optional fields are omitted rather than sent as "". */
export function runInputFromDraft(draft: RunDraft, chatId?: string): NewRunInput {
  const input: NewRunInput = {
    url: draft.url.trim(),
    maxFlows: draft.maxFlows,
    budget: draft.budget,
    reviewPlan: draft.reviewPlan,
  };
  const intent = draft.intent.trim();
  if (intent) input.intent = intent;
  const prd = draft.prdText.trim();
  if (prd) input.prd = prd;
  if (draft.requiresSignIn && draft.username && draft.password) {
    input.credentials = { username: draft.username, password: draft.password };
  }
  if (chatId) input.chatId = chatId;
  return input;
}

/**
 * The Start-a-run screen's state. Draft and flash live in one reducer because they always
 * change together: the flash is the record of what the last chat turn wrote, computed from
 * the transition rather than tracked separately and left to drift.
 */
export type FormState = { draft: RunDraft; flash: DraftField[] };

export type FormAction =
  /** A chat turn's writes, which are announced by flashing the fields they moved. */
  | { kind: "patch"; patch: DraftPatch }
  /** A hand edit. Never flashes: the person can see what they just typed. */
  | { kind: "edit"; fields: Partial<RunDraft> }
  /** A saved chat reopened, which replaces the form rather than merging into it. */
  | { kind: "load"; patch: DraftPatch }
  | { kind: "clearFlash" };

export function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.kind) {
    case "patch": {
      const draft = applyPatch(state.draft, action.patch);
      return { draft, flash: changedFields(state.draft, draft) };
    }
    case "edit":
      return { draft: withCredentialRule({ ...state.draft, ...action.fields }), flash: [] };
    case "load": {
      // The credentials are carried across because they were never in the saved draft: they
      // exist only in this page's state, so a load must not silently blank what was typed.
      const base = { ...DEFAULT_DRAFT, username: state.draft.username, password: state.draft.password };
      return { draft: applyPatch(base, action.patch), flash: [] };
    }
    case "clearFlash":
      return state.flash.length === 0 ? state : { ...state, flash: [] };
  }
}
