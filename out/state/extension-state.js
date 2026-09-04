"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.INITIAL_EXTENSION_STATE = exports.CURRENT_STATE_SCHEMA_VERSION = void 0;
exports.parseExtensionState = parseExtensionState;
exports.CURRENT_STATE_SCHEMA_VERSION = 2;
exports.INITIAL_EXTENSION_STATE = Object.freeze({
    schemaVersion: exports.CURRENT_STATE_SCHEMA_VERSION,
    previousSession: undefined,
    recentComparisons: [],
    unmanagedWarningAcknowledged: false,
});
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function optionalString(value) {
    return typeof value === 'string' && value.trim() ? value.slice(0, 200) : undefined;
}
function parseMode(value) {
    return value === 'readonly' ? 'readonly' : 'normal';
}
function parseSession(value) {
    if (!isRecord(value) || typeof value.leftUri !== 'string' || typeof value.rightUri !== 'string')
        return undefined;
    if (!value.leftUri || !value.rightUri || value.leftUri === value.rightUri)
        return undefined;
    return {
        leftUri: value.leftUri,
        rightUri: value.rightUri,
        leftLabel: optionalString(value.leftLabel),
        rightLabel: optionalString(value.rightLabel),
        mode: parseMode(value.mode),
    };
}
function parseRecent(value) {
    if (!Array.isArray(value))
        return [];
    const records = [];
    const keys = new Set();
    for (const item of value) {
        if (!isRecord(item) || typeof item.leftUri !== 'string' || typeof item.rightUri !== 'string')
            continue;
        if (!item.leftUri || !item.rightUri || item.leftUri === item.rightUri)
            continue;
        const key = `${item.leftUri}\n${item.rightUri}`;
        if (keys.has(key))
            continue;
        keys.add(key);
        records.push({
            leftUri: item.leftUri,
            rightUri: item.rightUri,
            leftLabel: optionalString(item.leftLabel),
            rightLabel: optionalString(item.rightLabel),
            mode: parseMode(item.mode),
            usedAt: typeof item.usedAt === 'string' ? item.usedAt : new Date(0).toISOString(),
        });
        if (records.length >= 20)
            break;
    }
    return records;
}
/** 不明・破損・将来版の値を推測せず、現在の安全な初期値へ戻します。 */
function parseExtensionState(value) {
    if (!isRecord(value) || value.schemaVersion !== exports.CURRENT_STATE_SCHEMA_VERSION) {
        return exports.INITIAL_EXTENSION_STATE;
    }
    return {
        schemaVersion: exports.CURRENT_STATE_SCHEMA_VERSION,
        previousSession: parseSession(value.previousSession),
        recentComparisons: parseRecent(value.recentComparisons),
        unmanagedWarningAcknowledged: value.unmanagedWarningAcknowledged === true,
    };
}
