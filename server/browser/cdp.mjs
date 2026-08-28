/**
 * Chrome DevTools Protocol session — Chrome, Brave and Edge.
 *
 * The browser is started with `--remote-debugging-port`, which it binds to
 * loopback itself. `GET /json/version` names the browser-level WebSocket; from
 * there the session creates one tab, attaches to it flat (so tab traffic is
 * multiplexed over the same socket with a `sessionId`) and drives it.
 */
import { WebSocketClient } from '../lib/websocket.mjs';
import { extractionExpression } from './extract.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;

/** Polls `/json/version` until the browser has opened its debugging port. */
export async function waitForDevTools(port, { timeoutMs = 20_000, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not started';
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`the browser did not open its DevTools port ${port} (${lastError})`);
}

export class CdpSession {
  #socket = null;
  #nextId = 1;
  #pending = new Map();
  #eventHandlers = new Set();
  #targetId = null;
  #sessionId = null;

  constructor({ webSocketDebuggerUrl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.webSocketDebuggerUrl = webSocketDebuggerUrl;
    this.timeoutMs = timeoutMs;
  }

  get isOpen() {
    return this.#socket?.isOpen === true;
  }

  async open() {
    const socket = new WebSocketClient(this.webSocketDebuggerUrl);
    socket.on('message', ({ data }) => this.#handleMessage(data));
    socket.on('close', () => this.#failPending(new Error('DevTools connection closed')));
    socket.on('error', (error) => this.#failPending(error));
    await socket.connect();
    this.#socket = socket;

    const target = await this.send('Target.createTarget', { url: 'about:blank' });
    this.#targetId = target.targetId;
    const attached = await this.send('Target.attachToTarget', {
      targetId: this.#targetId,
      flatten: true,
    });
    this.#sessionId = attached.sessionId;
    await this.send('Page.enable', {}, this.#sessionId);
    await this.send('Runtime.enable', {}, this.#sessionId);
    return this;
  }

  send(method, params = {}, sessionId) {
    if (!this.#socket?.isOpen) return Promise.reject(new Error('DevTools session is not open'));
    const id = this.#nextId++;
    const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`DevTools request timed out: ${method}`));
      }, this.timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  /** Navigates the attached tab and waits for the load event. */
  async navigate(url, { waitMs = this.timeoutMs } = {}) {
    const loaded = this.#once(
      (message) => message.method === 'Page.loadEventFired' && message.sessionId === this.#sessionId,
      waitMs,
    );
    const result = await this.send('Page.navigate', { url }, this.#sessionId);
    if (result.errorText) throw new Error(`navigation failed: ${result.errorText}`);
    // A load event that never arrives (a stalled subresource) must not hang
    // the turn: the DOM is usually usable well before `load`.
    await loaded.catch(() => undefined);
    return result;
  }

  async evaluate(expression) {
    const response = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      this.#sessionId,
    );
    if (response.exceptionDetails) {
      throw new Error(
        `page script failed: ${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}`,
      );
    }
    return response.result?.value;
  }

  /** Title, main text and links of the current page. */
  read(options) {
    return this.evaluate(extractionExpression(options));
  }

  async close() {
    try {
      if (this.#targetId && this.#socket?.isOpen) {
        await this.send('Target.closeTarget', { targetId: this.#targetId });
      }
    } catch {
      /* the browser is already gone */
    }
    this.#socket?.close();
    this.#socket = null;
    this.#failPending(new Error('DevTools session closed'));
  }

  #once(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#eventHandlers.delete(handler);
        reject(new Error('timed out waiting for a DevTools event'));
      }, timeoutMs);
      const handler = (message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.#eventHandlers.delete(handler);
        resolve(message);
      };
      this.#eventHandlers.add(handler);
    });
  }

  #handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? 'DevTools error'));
      else pending.resolve(message.result ?? {});
      return;
    }

    for (const handler of [...this.#eventHandlers]) handler(message);
  }

  #failPending(error) {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
