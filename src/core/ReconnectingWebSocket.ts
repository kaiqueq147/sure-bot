import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { backoffDelay, createLogger } from './logger.js';

export interface ReconnectingWebSocketOptions {
  name: string;
  /** Payload de heartbeat em nível de aplicação (ex: "PING"). Sem valor = usa ping de protocolo. */
  pingPayload?: string;
  pingIntervalMs?: number;
  /** Sem nenhuma mensagem por esse tempo, a conexão é considerada morta e é derrubada. */
  idleTimeoutMs?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  headers?: Record<string, string>;
}

/**
 * WebSocket com reconexão automática (backoff exponencial com jitter), heartbeat
 * e watchdog de inatividade. Eventos: `open`, `message` (string), `close` (code).
 */
export class ReconnectingWebSocket extends EventEmitter {
  private ws?: WebSocket;
  private attempt = 0;
  private stopped = true;
  private pingTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly log;

  constructor(
    private readonly url: string,
    private readonly opts: ReconnectingWebSocketOptions,
  ) {
    super();
    this.log = createLogger(`ws:${opts.name}`);
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.clearTimers();
    this.ws?.close();
  }

  /** Força uma reconexão (ex: após mudar a lista de assinaturas). */
  reconnect(): void {
    this.ws?.terminate();
  }

  send(data: string | object): boolean {
    if (!this.ws || !this.isOpen) return false;
    this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    return true;
  }

  private connect(): void {
    this.log.info(`conectando (tentativa ${this.attempt + 1})`);
    const ws = new WebSocket(this.url, { headers: this.opts.headers, handshakeTimeout: 10_000 });
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.log.info('conectado');
      this.armIdle();
      const interval = this.opts.pingIntervalMs ?? 10_000;
      this.pingTimer = setInterval(() => {
        if (this.opts.pingPayload) this.send(this.opts.pingPayload);
        else if (this.isOpen) ws.ping();
      }, interval);
      this.emit('open');
    });

    ws.on('message', (data) => {
      if (this.ws !== ws) return;
      this.armIdle();
      this.emit('message', data.toString());
    });

    ws.on('pong', () => this.ws === ws && this.armIdle());

    ws.on('error', (err) => this.log.warn('erro no socket', err));

    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.clearTimers();
      this.log.warn(`conexão fechada (code ${code})`);
      this.emit('close', code);
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    const timeout = this.opts.idleTimeoutMs ?? 30_000;
    this.idleTimer = setTimeout(() => {
      this.log.warn(`sem mensagens há ${timeout}ms, derrubando conexão`);
      this.ws?.terminate();
    }, timeout);
  }

  private scheduleReconnect(): void {
    const delay = backoffDelay(this.attempt++, this.opts.minDelayMs ?? 1_000, this.opts.maxDelayMs ?? 30_000);
    this.log.info(`reconectando em ${delay}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearTimers(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.idleTimer);
  }
}
