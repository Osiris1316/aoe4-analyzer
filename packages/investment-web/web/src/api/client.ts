// Reading the API. Every call is a GET; answers are kept for a short while so
// moving back and forth between pages doesn't load the same thing twice.
import { useEffect, useState } from 'react';

export class HttpError extends Error {
  constructor(public status: number) { super('HTTP ' + status); }
}

const cache = new Map<string, { at: number; data: unknown }>();
const FRESH_MS = 60_000;

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.data as T;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new HttpError(res.status);
  const data = (await res.json()) as T;
  cache.set(url, { at: Date.now(), data });
  return data;
}

/** The answer already in hand for this address, if any. */
export function cached<T>(url: string): T | undefined {
  const hit = cache.get(url);
  return hit && Date.now() - hit.at < FRESH_MS ? (hit.data as T) : undefined;
}

export interface Loaded<T> {
  data: T | undefined;
  /** True while a newer answer is on its way; `data` still holds the last one. */
  loading: boolean;
  error: HttpError | Error | null;
}

/**
 * Load a URL; null loads nothing. While a new URL loads, the last answer stays
 * in `data`, so lists don't blank out between filter changes.
 */
export function useJson<T>(url: string | null): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>(() => ({ data: url ? cached<T>(url) : undefined, loading: !!url && !cached(url), error: null }));
  useEffect(() => {
    if (!url) { setState({ data: undefined, loading: false, error: null }); return; }
    const ready = cached<T>(url);
    if (ready) { setState({ data: ready, loading: false, error: null }); return; }
    const ctl = new AbortController();
    setState((s) => ({ data: s.data, loading: true, error: null }));
    getJson<T>(url, ctl.signal).then(
      (data) => setState({ data, loading: false, error: null }),
      (error: unknown) => {
        if (ctl.signal.aborted) return;
        setState((s) => ({ data: s.data, loading: false, error: error instanceof Error ? error : new Error(String(error)) }));
      },
    );
    return () => ctl.abort();
  }, [url]);
  return state;
}

export const withVersion = (path: string, version: string | null | undefined): string =>
  version ? path + (path.includes('?') ? '&' : '?') + 'version=' + encodeURIComponent(version) : path;
