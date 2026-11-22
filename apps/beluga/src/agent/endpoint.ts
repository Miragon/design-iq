/**
 * Where an agent reaches Beluga: MCP over HTTP on 127.0.0.1, for programs on
 * this computer only, and only with Beluga's key. A web page cannot get in: a
 * request that names another host (DNS rebinding) or comes from a page (it
 * carries an Origin) is refused before the key is even looked at.
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { localhostHostValidation, mountStatelessMcp } from "@designiq/mcp-kit/mount";

import { type Control, createAgentServer } from "./server.ts";

/** the port Beluga listens on unless told otherwise: fixed, so an agent's configuration keeps working */
export const AGENT_PORT = 47913;
/** a request body larger than this is no MCP message Beluga answers */
const MAX_BODY = 1_000_000;

export interface AgentEndpoint {
  url: string;
  close(): Promise<void>;
}

function refuse(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function hasKey(header: string | undefined, key: string): boolean {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(key);
  // without a key nobody gets in, not even with an empty one
  return expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
}

/** opens the endpoint; `port` 0 takes a free one (tests) */
export function openAgentEndpoint(options: {
  port: number;
  key: () => string;
  control: Control;
}): Promise<AgentEndpoint> {
  const localHost = localhostHostValidation();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!localHost(req, res)) return;
    if (req.headers.origin !== undefined) return refuse(res, 403, "Web pages may not control Beluga.");
    if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/mcp") return refuse(res, 404, "Not found.");
    if (!hasKey(req.headers.authorization, options.key())) {
      return refuse(res, 401, "Beluga's key is missing or wrong.", { "WWW-Authenticate": "Bearer" });
    }
    if (req.method !== "POST") return refuse(res, 405, "Method not allowed.", { Allow: "POST" });
    void mountStatelessMcp(req, res, createAgentServer(options.control), { maxBytes: MAX_BODY });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
