/**
 * The interface's two surfaces.
 *
 *   /        the brain — the graph, the panels, the whole system at a glance
 *   /voice   voice mode — nothing but the conversation with ZERO
 *
 * A router, not a routing library: two routes, the History API, and a hash
 * fallback so the mode also works when the page is opened without a server
 * that rewrites unknown paths.
 */
import { useCallback, useEffect, useState } from 'react';

export type Route = 'brain' | 'voice';

export const VOICE_PATH = '/voice';

/** Maps a location onto a route. Exported so the mapping itself is testable. */
export function routeFromLocation(location: { pathname?: string; hash?: string }): Route {
  const path = (location.pathname ?? '/').replace(/\/+$/, '') || '/';
  if (path === VOICE_PATH) return 'voice';
  const hash = (location.hash ?? '').replace(/^#/, '').replace(/\/+$/, '');
  if (hash === VOICE_PATH || hash === 'voice') return 'voice';
  return 'brain';
}

export function pathForRoute(route: Route): string {
  return route === 'voice' ? VOICE_PATH : '/';
}

export interface RouteApi {
  route: Route;
  navigate: (route: Route) => void;
  toggleVoice: () => void;
}

export function useRoute(): RouteApi {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === 'undefined' ? 'brain' : routeFromLocation(window.location),
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sync = (): void => setRoute(routeFromLocation(window.location));
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);

  const navigate = useCallback((next: Route) => {
    setRoute(next);
    if (typeof window === 'undefined') return;
    const path = pathForRoute(next);
    if (routeFromLocation(window.location) === next) return;
    try {
      window.history.pushState({ route: next }, '', path);
    } catch {
      // A sandboxed or file:// document refuses pushState; the hash still works.
      window.location.hash = next === 'voice' ? VOICE_PATH : '';
    }
  }, []);

  const toggleVoice = useCallback(() => {
    navigate(routeFromLocation(window.location) === 'voice' ? 'brain' : 'voice');
  }, [navigate]);

  return { route, navigate, toggleVoice };
}
