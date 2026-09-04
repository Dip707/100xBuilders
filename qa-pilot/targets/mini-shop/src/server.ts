import type { Server } from "node:http";
import { createApp } from "./app.js";

export function startServer(port = Number(process.env.PORT ?? 3005)): Promise<Server> {
  return new Promise((resolve) => {
    const server = createApp().listen(port, () => resolve(server));
  });
}

if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  startServer().then((s) => {
    const addr = s.address() as { port: number };
    console.log(`mini-shop listening on http://localhost:${addr.port}`);
  });
}
