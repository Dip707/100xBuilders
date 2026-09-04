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
export const StepSchema = z.object({
  action: z.enum(["goto", "fill", "click", "select", "press", "check"]),
  target: z.string().optional(),   // goto: path
  role: z.string().optional(),
  name: z.string().optional(),
  value: z.string().optional(),    // fill/select/press value
  intent: z.string().optional(),   // human description, used by healer
});
export type Step = z.infer<typeof StepSchema>;

export const SiteMapSchema = z.object({
  origin: z.string(),
  loginPath: z.string().nullable(),
  loginSteps: z.array(StepSchema),
  pages: z.record(z.string(), PageInfoSchema),
});
export type SiteMap = z.infer<typeof SiteMapSchema>;

export const ExpectationSchema = z.object({
  type: z.enum(["visible", "not_visible", "text_contains", "url_contains", "url_stays", "value_equals"]),
  role: z.string().optional(),
  name: z.string().optional(),
  text_contains: z.string().optional(),
  value: z.string().optional(),
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
});
export type Flow = z.infer<typeof FlowSchema>;

// ---------- Coverage ----------
export const CoverageGapSchema = z.object({
  kind: z.enum(["missing_happy", "missing_negative", "missing_empty_submit", "missing_authz", "prd_uncovered", "intent_uncovered", "category_mix"]),
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
  network: z.array(NetworkEntrySchema).default([]),
  consoleErrors: z.array(z.string()).default([]),
  pageErrors: z.array(z.string()).default([]),
  tracePath: z.string().optional(),
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
  action: z.enum(["heal", "escalate", "rerun", "needs_human", "stop"]),
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
  step: z.number(),
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
  startedAt: Annotation<string>(),
  siteMap: Annotation<SiteMap | undefined>(),
  plan: Annotation<Flow[]>({ reducer: (_a, b) => b, default: () => [] }),
  coverage: Annotation<CoverageVerdict | undefined>(),
  planIterations: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  testFiles: Annotation<string[]>(append<string>()),
  unresolvedFlows: Annotation<string[]>(append<string>()),
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
    startedAt: new Date().toISOString(),
    siteMap: undefined,
    plan: [],
    coverage: undefined,
    planIterations: 0,
    testFiles: [],
    unresolvedFlows: [],
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
  };
}

/** Resolved on every call so tests can point QA_PILOT_OUTPUT at a temp dir. Always ends with "/". */
export function outputDir(runId: string): string {
  const root = process.env.QA_PILOT_OUTPUT ?? new URL("../../output/", import.meta.url).pathname;
  return `${root.endsWith("/") ? root : root + "/"}${runId}/`;
}
