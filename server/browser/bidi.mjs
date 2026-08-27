/**
 * WebDriver BiDi session — Firefox.
 *
 * Firefox's remote agent (`--remote-debugging-port`) speaks WebDriver BiDi,
 * not the DevTools Protocol. A session is created over the classic HTTP
 * endpoint with `webSocketUrl: true`; the response carries the WebSocket the
 * commands then run over.
 *
 * The command set used here is the same three operations the CDP session
 * needs — create a context, navigate it, evaluate a script in it — so the
 * bridge can treat both families identically.
 */
import { WebSocketClient } from '../lib/websocket.mjs';
import { extractionExpression } from './extract.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;

/** Polls the remote agent until Firefox accepts a WebDriver session. */
export async function createBidiSession(port, { timeoutMs = 25_000, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not started';
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          capabilities: { alwaysMatch: { webSocketUrl: true, acceptInsecureCerts: false } },
        }),
      });
      if (response.ok) {
        const body = await response.json();
        const capabilities = body?.value?.capabilities ?? {};
        const webSocketUrl = capabilities.webSocketUrl;
        if (typeof webSocketUrl === 'string') {
          return { sessionId: body.value.sessionId, webSocketUrl, capabilities };
        }
        lastError = 'the remote agent returned no webSocketUrl';
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Firefox did not open a WebDriver BiDi session on port ${port} (${lastError})`);
}

export class BidiSession {
  #socket = null;
  #nextId = 1;
  #pending = new Map();
  #context = null;

  constructor({ webSocketUrl, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.webSocketUrl = webSocketUrl;
    this.sessionId = sessionId;
    this.timeoutMs = timeoutMs;
  }

  get isOpen() {
    return this.#socket?.isOpen === true;
  }

  async open() {
    const socket = new WebSocketClient(this.webSocketUrl);
    socket.on('message', ({ data }) => this.#handleMessage(data));
    socket.on('close', () => this.#failPending(new Error('WebDriver BiDi connection closed')));
    socket.on('error', (error) => this.#failPending(error));
    await socket.connect();
    this.#socket = socket;

    const created = await this.send('browsingContext.create', { type: 'tab' });
    this.#context = created.context;
    return this;
  }

  send(method, params = {}) {
    if (!this.#socket?.isOpen) return Promise.reject(new Error('BiDi session is not open'));
    const id = this.#nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`BiDi request timed out: ${method}`));
      }, this.timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  async navigate(url) {
    return this.send('browsingContext.navigate', {
      context: this.#context,
      url,
      wait: 'complete',
    });
  }

  async evaluate(expression) {
    const response = await this.send('script.evaluate', {
      expression,
      target: { context: this.#context },
      awaitPromise: true,
      resultOwnership: 'none',
    });
    if (response.type === 'exception') {
      throw new Error(`page script failed: ${response.exceptionDetails?.text ?? 'unknown error'}`);
    }
    return deserialize(response.result);
  }

  read(options) {
    return this.evaluate(extractionExpression(options));
  }

  async close() {
    try {
      if (this.#context && this.#socket?.isOpen) {
        await this.send('browsingContext.close', { context: this.#context });
      }
    } catch {
      /* the browser is already gone */
    }
    this.#socket?.close();
    this.#socket = null;
    this.#failPending(new Error('BiDi session closed'));
  }

  #handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id === undefined) return; // an event; the bridge subscribes to none
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.type === 'error') {
      pending.reject(new Error(message.message ?? `BiDi error: ${message.error}`));
      return;
    }
    pending.resolve(message.result ?? {});
  }

  #failPending(error) {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

/**
 * BiDi returns values in its own tagged representation
 * (`{type: 'object', value: [[key, value], …]}`), unlike CDP's plain JSON.
 * This turns it back into the same shape the extraction script returned.
 */
export function deserialize(node) {
  if (node === null || node === undefined) return null;
  switch (node.type) {
    case 'undefined':
      return undefined;
    case 'null':
      return null;
    case 'string':
    case 'boolean':
      return node.value;
    case 'number':
      if (node.value === 'NaN') return Number.NaN;
      if (node.value === 'Infinity') return Number.POSITIVE_INFINITY;
      if (node.value === '-Infinity') return Number.NEGATIVE_INFINITY;
      return Number(node.value);
    case 'array':
    case 'set':
      return (node.value ?? []).map(deserialize);
    case 'object':
    case 'map': {
      const result = {};
      for (const entry of node.value ?? []) {
        const [key, value] = entry;
        result[typeof key === 'string' ? key : deserialize(key)] = deserialize(value);
      }
      return result;
    }
    default:
      return node.value ?? null;
  }
}
