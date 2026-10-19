import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createLogger } from './core/logger.js';

const log = createLogger('server');

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

export interface ServerOptions {
  port: number;
  /** Interface de escuta. 0.0.0.0 para o processo aceitar tráfego de fora do container. */
  host?: string;
  publicDir: string;
  /** Rotas JSON de diagnóstico: `GET /api/<nome>` */
  api: Record<string, (params: URLSearchParams) => unknown>;
  /** `POST /api/<nome>` com corpo JSON */
  post?: Record<string, (body: unknown, params: URLSearchParams) => unknown>;
  /** Mensagem enviada a cada cliente recém-conectado */
  snapshot: () => unknown;
}

export function startServer(opts: ServerOptions) {
  const root = path.resolve(opts.publicDir);

  const http = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end('{"ok":true}');
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5);
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
      };
      try {
        if (req.method === 'POST') {
          const handler = opts.post?.[name];
          if (!handler) return void json(404, { error: `rota POST /api/${name} não existe` });
          return void json(200, handler(await readJson(req), url.searchParams));
        }
        const handler = opts.api[name];
        if (!handler) return void json(404, { error: `rota /api/${name} não existe` });
        return void json(200, handler(url.searchParams));
      } catch (err) {
        log.error(`falha em ${url.pathname}`, err);
        return void json(500, { error: (err as Error).message });
      }
    }

    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep)) return void res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  const wss = new WebSocketServer({ server: http, path: '/ws' });
  const alive = new WeakSet<WebSocket>();

  wss.on('connection', (ws) => {
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    ws.send(JSON.stringify(opts.snapshot()));
  });

  // Derruba clientes que não respondem ao ping (aba fechada sem FIN, rede caiu etc.).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, 30_000);

  // O WebSocketServer reemite os erros do servidor HTTP; sem este handler o processo cai com stack trace.
  wss.on('error', () => {});
  http.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.error(
        `a porta ${opts.port} já está em uso (provavelmente outra instância do sure-bot). ` +
          `Feche-a ou rode com outra porta: $env:PORT="3001"; npm run dev`,
      );
    } else {
      log.error('falha no servidor HTTP', err);
    }
    process.exit(1);
  });
  const host = opts.host || '0.0.0.0';
  http.listen(opts.port, host, () => log.info(`dashboard em http://localhost:${opts.port}`));

  return {
    broadcast(msg: unknown) {
      const data = JSON.stringify(msg);
      for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}
