import { describe, it, expect } from "vitest";
import { z } from "zod";
import { extractJson, schemaInstruction, compatMode, baseUrl } from "../src/llm/client.js";
import { HealSuggestionSchema } from "../src/nodes/heal.js";
import { SelfRepairSchema, ExpectRepairSchema } from "../src/nodes/generate.js";

describe("extractJson", () => {
  it("returns a bare JSON object untouched", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it("unwraps a ```json fence", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("unwraps an unlabelled fence", () => {
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("drops a prose preamble", () => {
    expect(extractJson('Sure! Here is the plan:\n{"a":1}')).toBe('{"a":1}');
  });

  it("drops prose after the value", () => {
    expect(extractJson('{"a":1}\n\nLet me know if you want more flows.')).toBe('{"a":1}');
  });

  it("takes a top-level array", () => {
    expect(extractJson("[1,2]")).toBe("[1,2]");
  });

  it("spans nested structures of the other bracket kind", () => {
    const v = '{"gaps":[{"kind":"missing_negative"}],"score":0.6}';
    expect(extractJson(`preamble ${v} trailer`)).toBe(v);
  });

  it("is not fooled by a brace inside a string", () => {
    // This pipeline emits CSS/attribute selectors constantly, so this is the realistic case.
    const v = '{"selector":"div[role=\\"alert\\"] > span{x}"}';
    expect(extractJson(v)).toBe(v);
    expect(JSON.parse(extractJson(v))).toEqual({ selector: 'div[role="alert"] > span{x}' });
  });

  it("is not fooled by an escaped quote inside a string", () => {
    const v = '{"text":"he said \\"hi\\" }"}';
    expect(extractJson(v)).toBe(v);
  });

  it("throws when the reply carries no JSON at all", () => {
    expect(() => extractJson("I cannot help with that.")).toThrow(/no JSON object or array/);
  });

  it("throws on a truncated value instead of returning a parseable prefix", () => {
    // The whole point of the balanced scan: this prefix would parse as {"score":0.9} and
    // pass a schema whose other fields are optional, silently shrinking the test plan.
    const truncated = '{"score":0.9,"gaps":[{"kind":"missing_negative"';
    expect(() => extractJson(truncated)).toThrow(/unterminated/);
  });
});

describe("schemaInstruction", () => {
  it("renders the schema so the model is told the shape", () => {
    const out = schemaInstruction(z.object({ score: z.number(), gaps: z.array(z.string()) }));
    expect(out).toContain("Response format");
    expect(out).toContain('"score"');
    expect(out).toContain('"gaps"');
  });

  it("still asks for bare JSON when the schema cannot be rendered", () => {
    // A transform has no JSON Schema representation; the call must still go out.
    const weird = z.string().transform((v) => v.length);
    const out = schemaInstruction(weird as unknown as z.ZodType<unknown>);
    expect(out).toContain("Response format");
  });
});

describe("compatMode", () => {
  const saved = { ...process.env };
  const reset = () => {
    delete process.env.QA_PILOT_LLM_COMPAT;
    delete process.env.QA_PILOT_LLM_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
  };

  it("is off by default, so the native Anthropic path is unchanged", () => {
    reset();
    expect(compatMode()).toBe(false);
    expect(baseUrl()).toBeUndefined();
    Object.assign(process.env, saved);
  });

  it("turns on when a base URL points somewhere else", () => {
    reset();
    process.env.QA_PILOT_LLM_BASE_URL = "http://localhost:4444";
    expect(compatMode()).toBe(true);
    expect(baseUrl()).toBe("http://localhost:4444");
    Object.assign(process.env, saved);
  });

  it("honours an explicit override in both directions", () => {
    reset();
    process.env.QA_PILOT_LLM_BASE_URL = "http://localhost:4444";
    process.env.QA_PILOT_LLM_COMPAT = "0";
    expect(compatMode()).toBe(false);
    reset();
    process.env.QA_PILOT_LLM_COMPAT = "1";
    expect(compatMode()).toBe(true);
    Object.assign(process.env, saved);
  });
});

describe("reasoning-first field order", () => {
  // Generation is left-to-right, so a `reason` emitted after the field it explains is a
  // rationalisation of a token already committed rather than the thinking that chose it.
  // Both transports carry the order - native through output_config, compat through the schema
  // rendered into the system prompt - so the invariant is checked on both.
  const cases = [
    ["HealSuggestion", HealSuggestionSchema, ["candidate"]],
    ["SelfRepair", SelfRepairSchema, ["source"]],
    ["ExpectRepair", ExpectRepairSchema, ["role", "name", "value"]],
  ] as const;
  for (const [name, schema, decisions] of cases) {
    it(`emits reason before ${decisions.join("/")} in ${name}`, () => {
      const keys = Object.keys((z.toJSONSchema(schema, { io: "output" }) as { properties: Record<string, unknown> }).properties);
      expect(keys).toContain("reason");
      for (const d of decisions) expect(keys.indexOf("reason")).toBeLessThan(keys.indexOf(d));
      const rendered = schemaInstruction(schema);
      for (const d of decisions) expect(rendered.indexOf('"reason"')).toBeLessThan(rendered.indexOf(`"${d}"`));
    });
  }
});
