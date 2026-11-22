// What the whole site knows on every page: the metric version, civs and
// groups for the filters, and when results last changed (/api/meta).
import { createContext, useContext, type ReactNode } from 'react';
import { useJson } from '../api/client';
import type { Meta } from '../api/types';

const EMPTY: Meta = { version: null, civs: [], groups: [], analysedGames: 0, updated: null };
const MetaContext = createContext<{ meta: Meta; ready: boolean }>({ meta: EMPTY, ready: false });

export function MetaProvider({ children }: { children: ReactNode }) {
  const { data, loading, error } = useJson<Meta>('/api/meta');
  return <MetaContext.Provider value={{ meta: data ?? EMPTY, ready: !!data || (!loading && !!error) }}>{children}</MetaContext.Provider>;
}

export const useMeta = () => useContext(MetaContext);
