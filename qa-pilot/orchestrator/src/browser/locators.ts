import type { Locator, Page } from "playwright";

export type Strategy = "role" | "label" | "text" | "testid" | "css";
export type ResolvedLocator = { locator: Locator; code: string; strategy: Strategy };
export type LocatorTarget = { role?: string; name?: string; css?: string };

const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

async function count(locator: Locator): Promise<number> {
  try {
    return await locator.count();
  } catch {
    return 0;
  }
}

/**
 * Resolution chain: getByRole (exact name, then loose name match) -> getByLabel -> getByText ->
 * getByTestId -> CSS. Each candidate is only accepted when it resolves to exactly one element
 * (or, for role-only / css targets, at least one - the first is then used). The emitted `code`
 * always uses the plain (non-exact) getByRole form, since that is what generated test files
 * should read even when the exact-name lookup is what proved uniqueness.
 */
export async function resolveLocator(page: Page, t: LocatorTarget): Promise<ResolvedLocator | null> {
  const candidates: (() => Promise<ResolvedLocator | null>)[] = [];

  if (t.role && t.name) {
    const role = t.role as Parameters<Page["getByRole"]>[0];
    const name = t.name;
    const code = `page.getByRole(${q(t.role)}, { name: ${q(name)} })`;
    candidates.push(async () => {
      const exact = page.getByRole(role, { name, exact: true });
      if ((await count(exact)) === 1) return { locator: exact, code, strategy: "role" };
      const loose = page.getByRole(role, { name });
      if ((await count(loose)) === 1) return { locator: loose, code, strategy: "role" };
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

  if (t.css) {
    const css = t.css;
    candidates.push(async () => {
      const l = page.locator(css);
      return (await count(l)) >= 1
        ? { locator: l.first(), code: `page.locator(${q(css)}).first()`, strategy: "css" }
        : null;
    });
  }

  for (const c of candidates) {
    const r = await c();
    if (r) return r;
  }
  return null;
}
