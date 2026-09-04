import { startServer } from "../../../targets/mini-shop/src/server.js";
import type { Server } from "node:http";

export async function startShop(): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = await startServer(0);
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}
