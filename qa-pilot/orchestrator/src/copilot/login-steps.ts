import { z } from "zod";
import { StepSchema, type Credentials, type Step } from "../state.js";
import { readOutput, writeOutput } from "../output.js";

/**
 * The recorded sign-in with its credential values swapped for placeholders. Written at the
 * end of every run so a later rerun can sign in again with credentials typed fresh into the
 * copilot, without a credential ever being written to disk. The same redaction the suite
 * bundle performs for fixtures.ts, kept as data instead of TypeScript.
 */
export const LOGIN_STEPS_FILE = "login-steps.json";

const USERNAME = "{{username}}";
const PASSWORD = "{{password}}";

export function redactLoginSteps(steps: Step[], credentials?: Credentials): Step[] {
  if (!credentials) return steps.map((s) => ({ ...s }));
  return steps.map((s) => {
    if (s.value === undefined) return { ...s };
    // Password first: if someone uses the same string for both, the value reads as the password,
    // which is the safer of the two to redact.
    const value = s.value === credentials.password ? PASSWORD : s.value === credentials.username ? USERNAME : s.value;
    return { ...s, value };
  });
}

export function hydrateLoginSteps(steps: Step[], credentials: Credentials): Step[] {
  return steps.map((s) => {
    if (s.value === PASSWORD) return { ...s, value: credentials.password };
    if (s.value === USERNAME) return { ...s, value: credentials.username };
    return { ...s };
  });
}

export function writeRedactedLoginSteps(runId: string, steps: Step[], credentials?: Credentials): void {
  writeOutput(runId, LOGIN_STEPS_FILE, redactLoginSteps(steps, credentials));
}

/** The redacted steps for a run, or null when the run predates the file or never finished. */
export function readRedactedLoginSteps(runId: string): Step[] | null {
  const raw = readOutput(runId, LOGIN_STEPS_FILE);
  if (raw === null) return null;
  try {
    const parsed = z.array(StepSchema).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
