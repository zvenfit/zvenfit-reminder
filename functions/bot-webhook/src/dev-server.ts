import { createServer, type IncomingMessage } from "node:http";
import type { ApiGatewayEvent } from "./api.js";
import { handler } from "./index.js";

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function headersFromRequest(req: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

export async function startDevServer(port: number): Promise<void> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      const body =
        req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS"
          ? undefined
          : await readBody(req);
      const event: ApiGatewayEvent = {
        httpMethod: req.method,
        path: url.pathname,
        url: url.toString(),
        headers: headersFromRequest(req),
        body,
      };
      const response = await handler(event);
      res.statusCode = response.statusCode;
      if (response.headers) {
        for (const [key, value] of Object.entries(response.headers)) {
          res.setHeader(key, value);
        }
      }
      res.end(response.body ?? "");
    } catch (error) {
      console.error(error);
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : "Internal Server Error");
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, () => {
      console.log(`Dev server listening on http://localhost:${port}`);
      resolve();
    });
  });
}
