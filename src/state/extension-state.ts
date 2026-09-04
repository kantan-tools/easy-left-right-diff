import type { ComparisonMode, RecentComparison } from '../shared-types';

export const CURRENT_STATE_SCHEMA_VERSION = 2 as const;

export interface PersistedComparisonSession {
  readonly leftUri: string;
  readonly rightUri: string;
  readonly leftLabel: string | undefined;
  readonly rightLabel: string | undefined;
  readonly mode: ComparisonMode;
}

export interface ExtensionState {
  readonly schemaVersion: typeof CURRENT_STATE_SCHEMA_VERSION;
  readonly previousSession: PersistedComparisonSession | undefined;
  readonly recentComparisons: readonly RecentComparison[];
  readonly unmanagedWarningAcknowledged: boolean;
}

export const INITIAL_EXTENSION_STATE: ExtensionState = Object.freeze({
  schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
  previousSession: undefined,
  recentComparisons: [],
  unmanagedWarningAcknowledged: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, 200) : undefined;
}

function parseMode(value: unknown): ComparisonMode {
  return value === 'readonly' ? 'readonly' : 'normal';
}

function parseSession(value: unknown): PersistedComparisonSession | undefined {
  if (!isRecord(value) || typeof value.leftUri !== 'string' || typeof value.rightUri !== 'string') return undefined;
  if (!value.leftUri || !value.rightUri || value.leftUri === value.rightUri) return undefined;
  return {
    leftUri: value.leftUri,
    rightUri: value.rightUri,
    leftLabel: optionalString(value.leftLabel),
    rightLabel: optionalString(value.rightLabel),
    mode: parseMode(value.mode),
  };
}

function parseRecent(value: unknown): RecentComparison[] {
  if (!Array.isArray(value)) return [];
  const records: RecentComparison[] = [];
  const keys = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.leftUri !== 'string' || typeof item.rightUri !== 'string') continue;
    if (!item.leftUri || !item.rightUri || item.leftUri === item.rightUri) continue;
    const key = `${item.leftUri}\n${item.rightUri}`;
    if (keys.has(key)) continue;
    keys.add(key);
    records.push({
      leftUri: item.leftUri,
      rightUri: item.rightUri,
      leftLabel: optionalString(item.leftLabel),
      rightLabel: optionalString(item.rightLabel),
      mode: parseMode(item.mode),
      usedAt: typeof item.usedAt === 'string' ? item.usedAt : new Date(0).toISOString(),
    });
    if (records.length >= 20) break;
  }
  return records;
}

/** 不明・破損・将来版の値を推測せず、現在の安全な初期値へ戻します。 */
export function parseExtensionState(value: unknown): ExtensionState {
  if (!isRecord(value) || value.schemaVersion !== CURRENT_STATE_SCHEMA_VERSION) {
    return INITIAL_EXTENSION_STATE;
  }
  return {
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    previousSession: parseSession(value.previousSession),
    recentComparisons: parseRecent(value.recentComparisons),
    unmanagedWarningAcknowledged: value.unmanagedWarningAcknowledged === true,
  };
}
