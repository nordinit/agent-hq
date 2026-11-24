'use client';

import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Page filters that survive a refresh.
 *
 * A filter lives in two places. The address bar holds it so a refresh, a bookmark or a pasted
 * link reopens the same view, and each browser tab keeps its own. Local storage holds it too so
 * that coming back through the sidebar, whose links carry no query string, restores it as well.
 * Reading prefers the address bar, then storage, then the default.
 *
 * Only an operator's change is written. Restoring a value on load writes nothing, so opening a
 * page never rewrites its address on its own.
 */

/** How one filter's value is written to, and read back from, a query parameter. */
export interface FilterCodec<T> {
  /** Undefined means the text is not a valid value, so the next source is tried. */
  parse(raw: string): T | undefined;
  serialize(value: T): string;
}

export const stringFilter: FilterCodec<string> = {
  parse: raw => raw,
  serialize: value => value,
};

/** Empty text means "none chosen". */
export const optionalStringFilter: FilterCodec<string | null> = {
  parse: raw => (raw === '' ? null : raw),
  serialize: value => value ?? '',
};

export const booleanFilter: FilterCodec<boolean> = {
  parse: raw => (raw === '1' ? true : raw === '0' ? false : undefined),
  serialize: value => (value ? '1' : '0'),
};

/** A positive integer id, or null for "all". */
export const idFilter: FilterCodec<number | null> = {
  parse: raw => {
    if (raw === '' || raw === 'all') return null;
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : undefined;
  },
  serialize: value => (value === null ? '' : String(value)),
};

export const idListFilter: FilterCodec<number[]> = {
  parse: raw => {
    if (raw === '') return [];
    const ids = raw.split(',').map(Number);
    return ids.every(id => Number.isInteger(id) && id > 0) ? ids : undefined;
  },
  serialize: value => value.join(','),
};

/**
 * A multi-select column filter. Items are percent-encoded before joining, so a value that holds a
 * comma (a gate message, say) round-trips. A selection made of only the empty string reads back
 * as no selection; no column filter offers such an option alone.
 */
export const stringListFilter: FilterCodec<string[]> = {
  parse: raw => {
    if (raw === '') return [];
    try {
      return raw.split(',').map(decodeURIComponent);
    } catch {
      return undefined;
    }
  },
  serialize: value => value.map(encodeURIComponent).join(','),
};

export function resolveFilterValue<T>(
  fromUrl: string | null,
  fromStorage: string | null,
  defaultValue: T,
  codec: FilterCodec<T>,
): T {
  for (const raw of [fromUrl, fromStorage]) {
    if (raw === null) continue;
    const parsed = codec.parse(raw);
    if (parsed !== undefined) return parsed;
  }
  return defaultValue;
}

/** The URL after setting one query parameter, or removing it when `value` is null. */
export function withSearchParam(href: string, name: string, value: string | null): string {
  const url = new URL(href);
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Storage is per page, so the same parameter name can mean different things on two pages. */
export function filterStorageKey(pathname: string, name: string): string {
  return `agent-hq:filter:${pathname}:${name}`;
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Write one filter to the address bar and to storage; null clears it from both.
 *
 * The address is replaced, not pushed, so filtering adds no Back-button stops. History state is
 * passed as null on purpose: Next.js only syncs useSearchParams for a replaceState call that
 * carries none of its own internal state.
 */
export function persistFilter(name: string, serialized: string | null): void {
  if (typeof window === 'undefined') return;
  const key = filterStorageKey(window.location.pathname, name);
  try {
    if (serialized === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, serialized);
  } catch {
    // Blocked storage must not break filtering; the address bar still holds the value.
  }
  window.history.replaceState(null, '', withSearchParam(window.location.href, name, serialized));
}

/**
 * useState for a filter that survives a refresh. `name` is the query parameter, unique per page.
 *
 * The page must render on the client only (any page that calls useSearchParams under a Suspense
 * boundary does), since the first value is read from the browser.
 */
export function usePersistentFilter<T>(
  name: string,
  defaultValue: T,
  codec: FilterCodec<T>,
): [T, Dispatch<SetStateAction<T>>] {
  // Callers pass literals such as [] or ['enabled'], so pin the first ones rather than react to
  // a new array on every render.
  const pinned = useRef({ defaultValue, codec });
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return defaultValue;
    return resolveFilterValue(
      new URLSearchParams(window.location.search).get(name),
      readStorage(filterStorageKey(window.location.pathname, name)),
      defaultValue,
      codec,
    );
  });
  // Tracks the latest value synchronously, so two functional updates in one tick compose.
  const current = useRef(value);

  const set = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    const { defaultValue: fallback, codec: io } = pinned.current;
    const previous = current.current;
    const next = typeof action === 'function' ? (action as (prev: T) => T)(previous) : action;
    current.current = next;
    setValue(next);
    const serialized = io.serialize(next);
    if (serialized === io.serialize(previous)) return;
    persistFilter(name, serialized === io.serialize(fallback) ? null : serialized);
  }, [name]);

  return [value, set];
}
