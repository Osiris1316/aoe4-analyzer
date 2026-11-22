import { useSyncExternalStore } from 'react';

/** Whether a media query matches, kept current as the window changes. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (f) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', f);
      return () => m.removeEventListener('change', f);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Wide screens show the picked game on a board beside the list; phones open cards in place. */
export const WIDE = '(min-width: 1100px)';
