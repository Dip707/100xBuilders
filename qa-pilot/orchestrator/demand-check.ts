import { readFileSync } from "node:fs";
import type { SiteMap } from "./src/state.js";
const map = JSON.parse(readFileSync("/tmp/claude-501/sitemap.json", "utf8")) as SiteMap;
const CONSTRAINED = new Set(["email", "password", "number", "tel", "url", "date"]);
const sig = (f: any) => JSON.stringify([f.submit?.name ?? "", f.fields.map((x: any) => `${x.name}|${x.type}|${x.required}`).sort()]);
const groups = new Map<string, any>();
for (const p of Object.values(map.pages)) for (const f of p.forms) if (!groups.has(sig(f))) groups.set(sig(f), { p: p.path, f });
let formCases = 0;
for (const { p, f } of groups.values()) {
  const n = 1 + (f.fields.some((x: any) => x.required || CONSTRAINED.has(x.type)) ? 1 : 0) + (f.fields.some((x: any) => x.required) ? 1 : 0);
  formCases += n;
  console.log(`form ${p}: ${n} cases`);
}
const gated = Object.values(map.pages).filter((p) => p.gated).length;
const routes = Object.values(map.pages).filter((p) => p.forms.length || p.buttons.length).length;
console.log(`\nform cases ${formCases} + gated ${gated} = ${formCases + gated} flows demanded; ${routes} routes need a flow each`);
