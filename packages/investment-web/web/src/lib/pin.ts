// Pinning: one player per browser, like following in the league manager.
// The pin lives in localStorage only; nothing is stored on the server. With a
// pin, Games opens on their games, and "Everyone" instead is remembered too.
import { useSyncExternalStore } from 'react';

export interface Pin { id: number; person: string; ids: number[] }

const PIN_KEY = 'aoe4inv.pinned';
const ALL_KEY = 'aoe4inv.everyone';

function readPin(): Pin | null {
  try {
    const v = JSON.parse(localStorage.getItem(PIN_KEY) || 'null') as Pin | null;
    return v && v.id && Array.isArray(v.ids) && v.ids.length ? v : null;
  } catch { return null; }
}
function readAll(): boolean {
  try { return localStorage.getItem(ALL_KEY) === '1'; } catch { return false; }
}

let snapshot = { pin: readPin(), everyone: readAll() };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

function subscribe(f: () => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}
// Another tab changed the pin.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== PIN_KEY && e.key !== ALL_KEY) return;
    snapshot = { pin: readPin(), everyone: readAll() };
    emit();
  });
}

export function usePin() {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export function setPin(pin: Pin | null) {
  try { if (pin) localStorage.setItem(PIN_KEY, JSON.stringify(pin)); else localStorage.removeItem(PIN_KEY); } catch { /* storage off: this visit only */ }
  // Pinning someone shows their games again.
  if (pin) { try { localStorage.setItem(ALL_KEY, '0'); } catch { /* this visit only */ } }
  snapshot = { pin, everyone: pin ? false : snapshot.everyone };
  emit();
}

export function setEveryone(on: boolean) {
  try { localStorage.setItem(ALL_KEY, on ? '1' : '0'); } catch { /* this visit only */ }
  snapshot = { ...snapshot, everyone: on };
  emit();
}

export const pinFrom = (person: string, id: number, accounts: { profileId: number }[]): Pin =>
  ({ id: Number(id), person, ids: accounts.length ? accounts.map((a) => Number(a.profileId)) : [Number(id)] });

export const isPinnedId = (pin: Pin | null, id: number | null | undefined): boolean =>
  !!(pin && id && pin.ids.includes(Number(id)));

/** Keep a pin's accounts current when a profile shows more (an alt added later). */
export function refreshPin(pin: Pin | null, person: string | null, accounts: { profileId: number }[]) {
  if (!pin || !person || !accounts.some((a) => Number(a.profileId) === pin.id)) return;
  const next = pinFrom(person, pin.id, accounts);
  if (next.person === pin.person && next.ids.join(',') === pin.ids.join(',')) return;
  setPin(next);
}
