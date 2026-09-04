import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer } from "../src/server.js";
import type { Server } from "node:http";

let server: Server;
let base: string;

beforeAll(async () => {
  server = await startServer(0);
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function login(): Promise<string> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "email=demo%40shop.test&password=demo1234",
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  return res.headers.get("set-cookie")!.split(";")[0];
}

describe("mini-shop", () => {
  it("serves the product list with an accessible heading", async () => {
    const html = await (await fetch(`${base}/products`)).text();
    expect(html).toContain("<h1>Products</h1>");
  });

  it("wrong password shows an alert and stays on /login", async () => {
    const res = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "email=demo%40shop.test&password=nope",
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('role="alert"');
  });

  it("gates /orders behind login", async () => {
    const res = await fetch(`${base}/orders`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Forders");
  });

  it("applies a valid coupon and rejects an invalid one", async () => {
    const cookie = await login();
    const ok = await fetch(`${base}/api/coupon`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ code: "SAVE10" }) });
    expect(ok.status).toBe(200);
    const bad = await fetch(`${base}/api/coupon`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ code: "NOPE" }) });
    expect(bad.status).toBe(400);
  });

  it("chaos: breakCoupon makes the coupon endpoint return 500", async () => {
    const cookie = await login();
    await fetch(`${base}/__chaos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ breakCoupon: true }) });
    const res = await fetch(`${base}/api/coupon`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ code: "SAVE10" }) });
    expect(res.status).toBe(500);
    await fetch(`${base}/__chaos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ breakCoupon: false }) });
  });

  it("chaos: renameCheckoutButton changes the button label", async () => {
    const cookie = await login();
    const before = await (await fetch(`${base}/checkout`, { headers: { cookie } })).text();
    expect(before).toContain("Place order");
    await fetch(`${base}/__chaos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ renameCheckoutButton: true }) });
    const after = await (await fetch(`${base}/checkout`, { headers: { cookie } })).text();
    expect(after).toContain("Complete purchase");
    expect(after).not.toContain("Place order");
  });
});
