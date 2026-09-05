import type { Server } from "node:http";
import { createApp } from "./app.js";

export function startServer(port = Number(process.env.PORT ?? 3005)): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createApp().listen(port, () => resolve(server));
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use - stop the process using it or set PORT to a free one`));
      } else {
        reject(err);
      }
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  startServer()
    .then((s) => {
      const addr = s.address() as { port: number };
      console.log(`mini-shop listening on http://localhost:${addr.port}`);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
