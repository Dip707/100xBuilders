import { z } from "zod";
import { Annotation } from "@langchain/langgraph";

// ---------- Site map ----------
export const ElementRefSchema = z.object({ role: z.string(), name: z.string() });
export type ElementRef = z.infer<typeof ElementRefSchema>;

export const FormFieldSchema = z.object({
  role: z.string(),            // textbox | combobox | checkbox | radio
  name: z.string(),            // accessible name (label)
  type: z.string().default("text"),
  required: z.boolean().default(false),
});
export const FormInfoSchema = z.object({
  id: z.string(),              // "<path>#<index>"
  fields: z.array(FormFieldSchema),
  submit: ElementRefSchema.nullable(),
});
export type FormInfo = z.infer<typeof FormInfoSchema>;
export const PageInfoSchema = z.object({
  url: z.string(),
  path: z.string(),
  title: z.string(),
  forms: z.array(FormInfoSchema),
  buttons: z.array(ElementRefSchema),
  links: z.array(z.object({ href: z.string(), text: z.string() })),
  gated: z.boolean(),
  snapshot: z.string(),
});
export type PageInfo = z.infer<typeof PageInfoSchema>;

// ---------- Flow ----------
export const StepSchema = z
  .object({
    action: z.enum(["goto", "fill", "click", "select", "press", "check"]),
    target: z.string().optional(),   // goto: path
    role: z.string().optional(),
    name: z.string().optional(),
    value: z.string().optional(),    // fill/select/press value
    intent: z.string().optional(),   // human description, used by healer
  })
  // A step that acts on the page has to say on what. The repair prompt used to hand back a
  // click with neither, which the dry walk could only log as `unresolved: ""` and drop.
  .refine((s) => s.action === "goto" || Boolean(s.role || s.name), {
    message: "a fill, click, select, press or check step needs the element's role or accessible name",
    path: ["name"],
  });
export type Step = z.infer<typeof StepSchema>;

export const SiteMapSchema = z.object({
  origin: z.string(),
  loginPath: z.string().nullable(),
  loginSteps: z.array(StepSchema),
  pages: z.record(z.string(), PageInfoSchema),
});
export type SiteMap = z.infer<typeof SiteMapSchema>;

/** What a URL expectation may match against: a path, query string or hash route, never prose or stray punctuation. */
const URL_FRAGMENT = /^[A-Za-z0-9/._~%?=&#-]+$/;
export const ExpectationSchema = z
  .object({
    type: z.enum(["visible", "not_visible", "text_contains", "url_contains", "url_stays", "value_equals"]),
    role: z.string().optional(),
    name: z.string().optional(),
    text_contains: z.string().optional(),
    value: z.string().optional(),
  })
  .refine((e) => !e.type.startsWith("url") || URL_FRAGMENT.test(e.value ?? e.text_contains ?? ""), {
    message: "a url_contains or url_stays expectation needs a value that is a URL path or fragment, such as /orders or /#/faq",
    path: ["value"],
  })
  // A role alone ("an alert is visible") is satisfied by any alert, including the app's own
  // error message, so an expectation has to say which element or which text it looks for.
  .refine((e) => !["visible", "not_visible", "text_contains"].includes(e.type) || Boolean(e.name || e.text_contains), {
    message: "a visible, not_visible or text_contains expectation needs a name (the element's accessible name) or text_contains (the text it must show)",
    path: ["text_contains"],
  });
export type Expectation = z.infer<typeof ExpectationSchema>;

export const FlowCategory = z.enum(["happy", "negative", "edge", "error_state", "authz"]);
export const FlowSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(3),
  category: FlowCategory,
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  preconditions: z.array(z.enum(["logged_out", "logged_in"])),
  steps: z.array(StepSchema).min(1),
  expected: z.array(ExpectationSchema).min(1),
  source: z.enum(["explored", "prd", "intent"]),
  /** The routes the planner's dry walk saw this flow on, in order, after its own steps. This is
   *  evidence, not a claim: a flow that reaches checkout by clicking through the cart never
   *  names that route in a goto, and the coverage scorer would not credit it without this. */
  visits: z.array(z.string()).optional(),
});
export type Flow = z.infer<typeof FlowSchema>;
/** What the model is asked to produce: a flow without the field only the dry walk can fill in. */
export const FlowInputSchema = FlowSchema.omit({ visits: true });

// ---------- Coverage ----------
export const CoverageGapSchema = z.object({
  kind: z.enum(["missing_happy", "missing_negative", "missing_empty_submit", "missing_authz", "missing_route_flow", "prd_uncovered", "intent_uncovered", "category_mix"]),
  target: z.string().optional(),
  requirement: z.string().optional(),
  suggest: z.string(),
});
export const CoverageVerdictSchema = z.object({
  score: z.number().min(0).max(1),
  gaps: z.array(CoverageGapSchema),
  untested_risk: z.array(z.object({ flow: z.string(), reason: z.string(), risk: z.enum(["low", "medium", "high"]) })),
  checks: z.record(z.string(), z.number()),   // per-check pass rate
  prdRequirements: z.array(z.string()).default([]),
  prdMatrix: z.record(z.string(), z.array(z.string())).default({}),  // requirement -> flow ids
});
export type CoverageVerdict = z.infer<typeof CoverageVerdictSchema>;

// ---------- Run results ----------
export const NetworkEntrySchema = z.object({ method: z.string(), url: z.string(), status: z.number(), at: z.number() });
export const TestResultSchema = z.object({
  id: z.string(),                       // flow id
  file: z.string(),
  title: z.string(),
  status: z.enum(["passed", "failed", "timedOut", "skipped", "interrupted"]),
  error: z.string().optional(),
  errorLine: z.number().optional(),
  failingStep: z.number().optional(),   // index into flow.steps, derived from errorLine
  failingExpect: z.number().optional(), // index into flow.expected when the failure is on an expect line
  network: z.array(NetworkEntrySchema).default([]),
  consoleErrors: z.array(z.string()).default([]),
  pageErrors: z.array(z.string()).default([]),
  tracePath: z.string().optional(),
  videoPath: z.string().optional(),      // copied out of Playwright's output dir, which it wipes on every invocation
  durationMs: z.number().default(0),
});
export type TestResult = z.infer<typeof TestResultSchema>;
export const RunResultsSchema = z.object({ tests: z.array(TestResultSchema), at: z.string() });
export type RunResults = z.infer<typeof RunResultsSchema>;

// ---------- Classification / defects / heals / decisions ----------
export const ClassificationSchema = z.object({
  test: z.string(),
  class: z.enum(["script", "defect", "flaky", "env", "needs_human"]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()),
  action: z.enum(["heal", "escalate", "rerun", "needs_human", "stop", "healed"]),
  rationale: z.string().optional(),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export const DefectSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  flow: z.string(),
  repro_steps: z.array(z.string()),
  expected: z.string(),
  actual: z.string(),
  evidence: z.array(z.string()),
  attachments: z.array(z.string()),
});
export type Defect = z.infer<typeof DefectSchema>;

export const HealRecordSchema = z.object({
  test: z.string(),
  attempt: z.number(),
  step: z.number().optional(),        // index into flow.steps for a step heal
  expectation: z.number().optional(), // index into flow.expected for an assertion re-target
  before: z.string(),
  after: z.string(),
  reason: z.string(),
  confidence: z.number(),
  accepted: z.boolean(),
});
export type HealRecord = z.infer<typeof HealRecordSchema>;

export const DecisionSchema = z.object({
  node: z.string(),
  reason: z.string(),
  evidence: z.array(z.string()),
  next: z.string(),
  at: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const CredentialsSchema = z.object({ username: z.string(), password: z.string() });
export type Credentials = z.infer<typeof CredentialsSchema>;

export const BudgetSchema = z.object({ maxLlmCalls: z.number().default(200), maxMinutes: z.number().default(40) });

// ---------- Run input ----------
export const RunInputSchema = z.object({
  runId: z.string(),
  url: z.string().url(),
  credentials: CredentialsSchema.optional(),
  intent: z.string().optional(),
  prdText: z.string().optional(),
  maxFlows: z.number().int().positive().default(12),
  budget: BudgetSchema.default({ maxLlmCalls: 200, maxMinutes: 40 }),
  // When true the graph pauses after the coverage gate so the plan can be reviewed, edited
  // and trimmed before any test is generated. Off by default: the pipeline is autonomous.
  reviewPlan: z.boolean().default(false),
});
export type RunInput = z.infer<typeof RunInputSchema>;

// ---------- Graph state ----------
const append = <T,>() => ({ reducer: (a: T[], b: T[]) => a.concat(b), default: () => [] as T[] });

export const RunStateAnnotation = Annotation.Root({
  runId: Annotation<string>(),
  url: Annotation<string>(),
  credentials: Annotation<Credentials | undefined>(),
  intent: Annotation<string | undefined>(),
  prdText: Annotation<string | undefined>(),
  maxFlows: Annotation<number>(),
  budget: Annotation<z.infer<typeof BudgetSchema>>(),
  reviewPlan: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  startedAt: Annotation<string>(),
  siteMap: Annotation<SiteMap | undefined>(),
  plan: Annotation<Flow[]>({ reducer: (_a, b) => b, default: () => [] }),
  coverage: Annotation<CoverageVerdict | undefined>(),
  planIterations: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  testFiles: Annotation<string[]>(append<string>()),
  unresolvedFlows: Annotation<string[]>(append<string>()),
  // Expectations the generator re-targeted after checking them live, by flow id. The plan
  // keeps what the planner wrote; every later node verifies against what the spec asserts.
  expectations: Annotation<Record<string, Expectation[]>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  currentFlow: Annotation<Flow | undefined>(),           // Send() payload for generateFlow
  testsToRun: Annotation<string[] | undefined>(),         // undefined = all
  results: Annotation<RunResults | undefined>(),
  classifications: Annotation<Classification[]>({ reducer: (_a, b) => b, default: () => [] }),
  healAttempts: Annotation<Record<string, number>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  rerunAttempts: Annotation<Record<string, number>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  healLog: Annotation<HealRecord[]>(append<HealRecord>()),
  defects: Annotation<Defect[]>(append<Defect>()),
  decisions: Annotation<Decision[]>(append<Decision>()),
  llmCalls: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  partial: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  // Generation fans out one node per flow, so several branches can fail in the same step and
  // each records why. Without a reducer LangGraph rejects the second write and aborts the whole
  // run - taking the report, and every test that did pass, with it. Distinct reasons are kept
  // in the order they arrived; a reason two branches share is recorded once.
  partialReason: Annotation<string | undefined>({
    reducer: (a, b) => (!b ? a : !a ? b : a.split("; ").includes(b) ? a : `${a}; ${b}`),
    default: () => undefined,
  }),
});
export type RunState = typeof RunStateAnnotation.State;
export type RunUpdate = typeof RunStateAnnotation.Update;

export function initialState(input: { runId: string; url: string } & Partial<RunInput>): RunState {
  const parsed = RunInputSchema.parse(input);
  return {
    runId: parsed.runId,
    url: parsed.url.replace(/\/$/, ""),
    credentials: parsed.credentials,
    intent: parsed.intent,
    prdText: parsed.prdText,
    maxFlows: parsed.maxFlows,
    budget: parsed.budget,
    reviewPlan: parsed.reviewPlan,
    startedAt: new Date().toISOString(),
    siteMap: undefined,
    plan: [],
    coverage: undefined,
    planIterations: 0,
    testFiles: [],
    unresolvedFlows: [],
    expectations: {},
    currentFlow: undefined,
    testsToRun: undefined,
    results: undefined,
    classifications: [],
    healAttempts: {},
    rerunAttempts: {},
    healLog: [],
    defects: [],
    decisions: [],
    llmCalls: 0,
    partial: false,
    partialReason: undefined,
  };
}

/**
 * What `startRun` accepts: a run input plus the account that owns the run.
 *
 * Deliberately a sibling of RunInputSchema rather than a field on it. `initialState`
 * parses RunInputSchema and is called from a couple of dozen node-level tests that have
 * no account and no need for one, so requiring userId there would be pure churn. It is
 * equally deliberately absent from RunStateAnnotation: the graph has no interest in who
 * owns a run, and putting it in graph state would widen the checkpointed payload for
 * nothing.
 */
export const StartRunInputSchema = RunInputSchema.extend({ userId: z.string().min(1) });
/** The input side of the schema: fields with defaults (budget, maxFlows, reviewPlan) stay optional for callers. */
export type StartRunInput = z.input<typeof StartRunInputSchema>;

/** Resolved on every call so tests can point QA_PILOT_OUTPUT at a temp dir. Always ends with "/". */
/** A flow's expectations as the generated spec asserts them: the planner's, unless the generator re-targeted them. */
export function effectiveExpectations(state: Pick<RunState, "expectations">, flow: Flow): Expectation[] {
  return state.expectations[flow.id] ?? flow.expected;
}

export function outputDir(runId: string): string {
  const root = process.env.QA_PILOT_OUTPUT ?? new URL("../../output/", import.meta.url).pathname;
  return `${root.endsWith("/") ? root : root + "/"}${runId}/`;
}
