import { useEffect, useState } from 'react';
import { DEFAULT_HARNESS, type HarnessOptions } from './harness-api';

const key = 'ege:engineering-harness:v1';
export function useHarnessOptions(graphId?: string) {
  const [saved, setSaved] = useState<Record<string, HarnessOptions>>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      return Object.fromEntries(Object.entries(value).flatMap(([id, item]) => {
        if (!item || typeof item !== 'object' || typeof item.enabled !== 'boolean' || !['poc', 'mvp', 'production'].includes(item.profile) || !Number.isFinite(item.tokenBudget) || typeof item.conventions !== 'string') return [];
        return [[id, { enabled: item.enabled, profile: item.profile, tokenBudget: Math.min(100000, Math.max(4000, item.tokenBudget)), conventions: item.conventions.slice(0, 8000) }]];
      }));
    } catch { return {}; }
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(saved)); } catch { /* Settings still work for this session. */ } }, [saved]);
  return [graphId && saved[graphId] || DEFAULT_HARNESS, (value: HarnessOptions) => { if (graphId) setSaved((current) => ({ ...current, [graphId]: value })); }] as const;
}
