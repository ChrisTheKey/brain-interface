import { describe, expect, it } from 'vitest';
import {
  ZERO_API_BASE,
  ZERO_EVENTS_WS_PATH,
  ZERO_HEALTH_PATH,
  ZERO_RUNTIME_WS_PATH,
  apiPath,
  sameOriginWsUrl,
  wsProtocolFor,
  zeroEventsWsUrl,
  zeroRuntimeWsUrl,
} from '../src/zero/endpoints';

describe('same-origin endpoints', () => {
  it('derives the WebSocket URL from the address the browser actually opened', () => {
    // The laptop, on loopback.
    expect(zeroRuntimeWsUrl({ protocol: 'http:', host: '127.0.0.1:3000' })).toBe(
      'ws://127.0.0.1:3000/ws',
    );
    // The same build, opened from the Samsung Galaxy over the LAN. This is the
    // case a hardcoded 127.0.0.1 got wrong: there it means the phone itself.
    expect(zeroRuntimeWsUrl({ protocol: 'http:', host: '192.168.1.23:3000' })).toBe(
      'ws://192.168.1.23:3000/ws',
    );
    // A hostname, not an IP, works identically — nothing parses the host.
    expect(zeroRuntimeWsUrl({ protocol: 'http:', host: 'zero-laptop.local:3000' })).toBe(
      'ws://zero-laptop.local:3000/ws',
    );
  });

  it('upgrades to wss on an https page and stays ws on http', () => {
    expect(wsProtocolFor('https:')).toBe('wss:');
    expect(wsProtocolFor('http:')).toBe('ws:');
    // A ws:// socket from an https page is blocked as mixed content, so this
    // is not cosmetic: getting it wrong means no connection at all.
    expect(zeroRuntimeWsUrl({ protocol: 'https:', host: 'zero-host' })).toBe('wss://zero-host/ws');
    expect(zeroEventsWsUrl({ protocol: 'https:', host: 'zero-host' })).toBe(
      'wss://zero-host/ws/events',
    );
    expect(zeroEventsWsUrl({ protocol: 'http:', host: '192.168.1.23:3000' })).toBe(
      'ws://192.168.1.23:3000/ws/events',
    );
  });

  it('never emits an absolute HTTP address', () => {
    expect(apiPath()).toBe('/api');
    expect(apiPath('/health')).toBe('/api/health');
    // A missing leading slash must not silently produce `/apihealth`.
    expect(apiPath('health')).toBe('/api/health');
    expect(ZERO_HEALTH_PATH).toBe('/api/health');
    for (const value of [ZERO_API_BASE, ZERO_RUNTIME_WS_PATH, ZERO_EVENTS_WS_PATH]) {
      expect(value.startsWith('/')).toBe(true);
      expect(value).not.toMatch(/:\/\//);
    }
  });

  it('refuses to invent an origin when the page has none', () => {
    expect(() => sameOriginWsUrl('/ws', { protocol: 'http:', host: '' })).toThrow(/origin host/);
  });
});
