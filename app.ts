// The forge's HTTP surface: health probe, API root, REST v3, GraphQL v4,
// MCP (streamable HTTP) and git smart HTTP — one process, one in-memory store.
//
// app.ts is the server; main.ts (untouched) owns the entry <-> env lifecycle.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The bearer token the suite sends; read once per request (env is fixed in a trial). */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  const expected = expectedToken();
  if (expected === '') return true; // no token configured (local dev): any non-empty bearer
  return token === expected;
}

function pathOf(req: IncomingMessage): string {
  try {
    const raw = new URL(req.url ?? '/', 'http://entry').pathname;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function lowerHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v;
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = store.nextRequestId();
      const sendJson = (status: number, body: unknown, extra: Readonly<Record<string, string>> = {}): void => {
        const text = body === null ? '' : `${JSON.stringify(body)}\n`;
        const headers: Record<string, string> = { 'x-github-request-id': requestId, ...extra };
        if (body !== null) {
          headers['content-type'] = JSON_TYPE;
          headers['content-length'] = String(Buffer.byteLength(text));
        } else {
          headers['content-length'] = '0';
        }
        res.writeHead(status, headers);
        res.end(text);
      };
      const sendRaw = (status: number, contentType: string, body: Buffer): void => {
        res.writeHead(status, {
          'content-type': contentType,
          'content-length': String(body.length),
          'x-github-request-id': requestId,
        });
        res.end(body);
      };
      const unauthorized = (): void => {
        sendJson(401, { message: 'Bad credentials' });
      };
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        const query = queryOf(req);

        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(200, { ok: true });
          return;
        }

        // The GitHub API root: a 200 with the token's scopes. No auth (as the starter ships it).
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
          return;
        }

        // API meta: version stamp, no auth.
        if (method === 'GET' && path === '/api/v3/meta') {
          sendJson(200, { installed_version: '1.0.0' });
          return;
        }

        // Git smart HTTP: /<owner>/<repo>.git/{info/refs,git-upload-pack,git-receive-pack}
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          if (!isAuthorized(req)) {
            unauthorized();
            return;
          }
          const owner = gitMatch[1];
          const repoName = gitMatch[2];
          const action = gitMatch[3];
          const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : null;
          if (action === 'info/refs') {
            if (method !== 'GET') {
              sendJson(404, { message: 'Not Found' });
              return;
            }
            const r = handleInfoRefs(store, owner, repoName, query.get('service'), gitProtocol);
            sendRaw(r.status, r.contentType, r.body);
            return;
          }
          if (method !== 'POST') {
            sendJson(404, { message: 'Not Found' });
            return;
          }
          const body = await readBody(req);
          const r =
            action === 'git-upload-pack'
              ? handleUploadPack(store, owner, repoName, body, gitProtocol)
              : handleReceivePack(store, owner, repoName, body);
          sendRaw(r.status, r.contentType, r.body);
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(404, { message: 'Not Found' });
            return;
          }
          if (!isAuthorized(req)) {
            unauthorized();
            return;
          }
          const text = (await readBody(req)).toString('utf8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            sendJson(400, { message: 'Bad Request' });
            return;
          }
          const r = handleGraphQL(store, parsed);
          sendJson(r.status, r.json);
          return;
        }

        // MCP (streamable HTTP).
        if (path === '/mcp') {
          if (method === 'DELETE') {
            // Legacy session close: best-effort, no body.
            sendJson(200, null);
            return;
          }
          if (method !== 'POST') {
            sendJson(404, { message: 'Not Found' });
            return;
          }
          if (!isAuthorized(req)) {
            unauthorized();
            return;
          }
          const text = (await readBody(req)).toString('utf8');
          const r = handleMcp(store, text);
          if (r.json === null) {
            sendJson(r.status, null);
          } else {
            sendJson(r.status, r.json);
          }
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!isAuthorized(req)) {
            unauthorized();
            return;
          }
          const text = (await readBody(req)).toString('utf8');
          const r = handleRest(store, method, path, query, lowerHeaders(req), text);
          sendJson(r.status, r.json, r.headers ?? {});
          return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(404, { message: 'Not Found' });
      } catch {
        if (!res.headersSent) {
          sendJson(500, { message: 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  });
}
