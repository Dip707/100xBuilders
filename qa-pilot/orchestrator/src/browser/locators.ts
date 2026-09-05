import type { Locator, Page } from "playwright";

export type Strategy = "role" | "label" | "text" | "testid" | "css";
export type ResolvedLocator = { locator: Locator; code: string; strategy: Strategy };
export type LocatorTarget = { role?: string; name?: string; css?: string };

export const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const q = quote;

async function count(locator: Locator): Promise<number> {
  try {
    return await locator.count();
  } catch {
    return 0;
  }
}

/** A CSS attribute selector for the data-test attribute, which Playwright's getByTestId does not read. */
const dataTest = (name: string) => `[data-test="${name.replace(/["\\]/g, "\\$&")}"]`;

/**
 * Resolution chain: getByRole (loose name match, then exact name match) -> getByLabel -> getByText ->
 * getByTestId -> data-test attribute -> CSS -> the first of several role matches. Each candidate
 * is only accepted when it resolves to exactly one element (or, for role-only / css targets, at
 * least one - the first is then used). The loose lookup is tried first since it is what generated
 * test files should prefer to read; the exact lookup is only used (with `exact: true` emitted in
 * the code) when the loose lookup is itself ambiguous.
 *
 * A role and name that match several elements and nothing more specific is not a dead end: a
 * product grid has one "Add to cart" per item, and a tester told to add a product presses the
 * first one. That fallback comes last so a unique label, text or test id still wins.
 */
export async function resolveLocator(page: Page, t: LocatorTarget): Promise<ResolvedLocator | null> {
  const candidates: (() => Promise<ResolvedLocator | null>)[] = [];

  if (t.role && t.name) {
    const role = t.role as Parameters<Page["getByRole"]>[0];
    const name = t.name;
    candidates.push(async () => {
      const loose = page.getByRole(role, { name });
      if ((await count(loose)) === 1) {
        return { locator: loose, code: `page.getByRole(${q(t.role!)}, { name: ${q(name)} })`, strategy: "role" };
      }
      const exact = page.getByRole(role, { name, exact: true });
      if ((await count(exact)) === 1) {
        return { locator: exact, code: `page.getByRole(${q(t.role!)}, { name: ${q(name)}, exact: true })`, strategy: "role" };
      }
      return null;
    });
  } else if (t.role) {
    const role = t.role as Parameters<Page["getByRole"]>[0];
    candidates.push(async () => {
      const l = page.getByRole(role);
      return (await count(l)) >= 1
        ? { locator: l.first(), code: `page.getByRole(${q(t.role!)}).first()`, strategy: "role" }
        : null;
    });
  }

  if (t.name) {
    const name = t.name;
    candidates.push(async () => {
      const l = page.getByLabel(name, { exact: true });
      return (await count(l)) === 1
        ? { locator: l, code: `page.getByLabel(${q(name)}, { exact: true })`, strategy: "label" }
        : null;
    });
    candidates.push(async () => {
      const l = page.getByText(name, { exact: true });
      return (await count(l)) === 1
        ? { locator: l, code: `page.getByText(${q(name)}, { exact: true })`, strategy: "text" }
        : null;
    });
    candidates.push(async () => {
      const l = page.getByTestId(name);
      return (await count(l)) === 1
        ? { locator: l, code: `page.getByTestId(${q(name)})`, strategy: "testid" }
        : null;
    });
  }

  if (t.name) {
    const name = t.name;
    candidates.push(async () => {
      const l = page.locator(dataTest(name));
      return (await count(l)) === 1
        ? { locator: l, code: `page.locator(${q(dataTest(name))})`, strategy: "testid" }
        : null;
    });
  }

  if (t.css) {
    const css = t.css;
    candidates.push(async () => {
      const l = page.locator(css);
      return (await count(l)) >= 1
        ? { locator: l.first(), code: `page.locator(${q(css)}).first()`, strategy: "css" }
        : null;
    });
  }

  if (t.role && t.name) {
    const role = t.role as Parameters<Page["getByRole"]>[0];
    const name = t.name;
    candidates.push(async () => {
      const loose = page.getByRole(role, { name });
      return (await count(loose)) > 1
        ? { locator: loose.first(), code: `page.getByRole(${q(t.role!)}, { name: ${q(name)} }).first()`, strategy: "role" }
        : null;
    });
  }

  for (const c of candidates) {
    const r = await c();
    if (r) return r;
  }
  return null;
}
