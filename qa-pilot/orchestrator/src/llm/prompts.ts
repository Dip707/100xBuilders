import { readFileSync } from "node:fs";

export function loadPrompt(name: string): string {
  const url = new URL(`./prompts/${name}.md`, import.meta.url);
  return readFileSync(url, "utf8");
}
