"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceStorage = exports.PENDING_RESTORE_FORMATS_KEY = exports.WORKSPACE_STATE_KEY = void 0;
const extension_state_1 = require("./extension-state");
exports.WORKSPACE_STATE_KEY = 'easyLeftRightDiff.extensionState';
exports.PENDING_RESTORE_FORMATS_KEY = 'easyLeftRightDiff.pendingRestoreFormats';
const MAX_PERSISTED_RESTORE_FORMATS = 30;
const PENDING_RESTORE_FORMATS_SCHEMA_VERSION = 3;
const PENDING_RESTORE_FORMATS_FILE = 'pending-restore-formats.json';
const PENDING_RESTORE_FORMATS_BACKUP_FILE = 'pending-restore-formats.backup.json';
const READ_RETRIES = 3;
const READ_RETRY_MS = 40;
function legacyRecordId(sourceUri, savedAt) {
    let hash = 0x811c9dc5;
    for (const char of `${sourceUri}\n${savedAt}`) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `legacy-${hash.toString(16).padStart(8, '0')}`;
}
function rawPendingRestoreRecords(value) {
    if (Array.isArray(value))
        return { generation: 0, records: value };
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return { generation: 0, records: [] };
    const candidate = value;
    return {
        generation: typeof candidate.generation === 'number' && Number.isSafeInteger(candidate.generation) && candidate.generation >= 0
            ? candidate.generation
            : 0,
        records: Array.isArray(candidate.records) ? candidate.records : [],
    };
}
function parsePendingRestoreFormats(value) {
    const raw = rawPendingRestoreRecords(value);
    const result = [];
    const seen = new Set();
    for (const item of raw.records) {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            continue;
        const record = item;
        if (typeof record.sourceUri !== 'string' || !record.sourceUri || seen.has(record.sourceUri))
            continue;
        if (typeof record.targetCtime !== 'number' || !Number.isFinite(record.targetCtime) || record.targetCtime <= 0)
            continue;
        if (typeof record.beforeNormalizedHash !== 'string' || !/^[0-9a-f]{16}$/.test(record.beforeNormalizedHash))
            continue;
        if (record.beforeEol !== 1 && record.beforeEol !== 2)
            continue;
        if (typeof record.beforeHasBom !== 'boolean')
            continue;
        if (typeof record.restoredNormalizedHash !== 'string' || !/^[0-9a-f]{16}$/.test(record.restoredNormalizedHash))
            continue;
        if (record.restoredEol !== 1 && record.restoredEol !== 2)
            continue;
        if (typeof record.restoredHasBom !== 'boolean')
            continue;
        const currentNormalizedHash = typeof record.currentNormalizedHash === 'string' && /^[0-9a-f]{16}$/.test(record.currentNormalizedHash)
            ? record.currentNormalizedHash
            : record.restoredNormalizedHash;
        const currentEol = record.currentEol === 1 || record.currentEol === 2 ? record.currentEol : record.restoredEol;
        const identityState = record.identityState === 'rename-pending' ? 'rename-pending' : 'verified';
        if (typeof record.savedAt !== 'string' || Number.isNaN(Date.parse(record.savedAt)))
            continue;
        const recordId = typeof record.recordId === 'string' && /^[A-Za-z0-9._-]{8,128}$/.test(record.recordId)
            ? record.recordId
            : legacyRecordId(record.sourceUri, record.savedAt);
        const revision = typeof record.revision === 'number' && Number.isSafeInteger(record.revision) && record.revision >= 1
            ? record.revision
            : 1;
        seen.add(record.sourceUri);
        result.push({
            sourceUri: record.sourceUri,
            recordId,
            revision,
            targetCtime: record.targetCtime,
            beforeNormalizedHash: record.beforeNormalizedHash,
            beforeEol: record.beforeEol,
            beforeHasBom: record.beforeHasBom,
            restoredNormalizedHash: record.restoredNormalizedHash,
            restoredEol: record.restoredEol,
            restoredHasBom: record.restoredHasBom,
            currentNormalizedHash,
            currentEol,
            identityState,
            savedAt: record.savedAt,
        });
    }
    return {
        schemaVersion: PENDING_RESTORE_FORMATS_SCHEMA_VERSION,
        generation: raw.generation,
        records: result
            .sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt))
            .slice(0, MAX_PERSISTED_RESTORE_FORMATS),
    };
}
function persistedSession(snapshot) {
    return {
        leftUri: snapshot.left.uri.toString(true),
        rightUri: snapshot.right.uri.toString(true),
        leftLabel: snapshot.leftLabel,
        rightLabel: snapshot.rightLabel,
        mode: snapshot.mode,
    };
}
function recentComparison(snapshot, usedAt = new Date()) {
    return {
        ...persistedSession(snapshot),
        usedAt: usedAt.toISOString(),
    };
}
function isMissingError(error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return message.includes('not found') || message.includes('enoent') || message.includes('missing');
}
function matchesExpected(current, expected) {
    if (expected === undefined)
        return true;
    if (expected === null)
        return current === undefined;
    return current?.recordId === expected.recordId && current.revision === expected.revision;
}
/** workspaceStateの読み書きを一箇所へ閉じ込め、セッション移行入口を提供します。 */
class WorkspaceStorage {
    memento;
    workspaceFs;
    pendingRestoreFormatFileUri;
    pendingRestoreFormatBackupUri;
    pendingRestoreFormatQueue = Promise.resolve();
    constructor(memento, storageUri, workspaceFs) {
        this.memento = memento;
        this.workspaceFs = workspaceFs;
        this.pendingRestoreFormatFileUri = storageUri
            ? storageUri.with({ path: `${storageUri.path.replace(/\/$/, '')}/${PENDING_RESTORE_FORMATS_FILE}` })
            : undefined;
        this.pendingRestoreFormatBackupUri = storageUri
            ? storageUri.with({ path: `${storageUri.path.replace(/\/$/, '')}/${PENDING_RESTORE_FORMATS_BACKUP_FILE}` })
            : undefined;
    }
    load() {
        return (0, extension_state_1.parseExtensionState)(this.memento.get(exports.WORKSPACE_STATE_KEY));
    }
    async save(state) {
        await this.memento.update(exports.WORKSPACE_STATE_KEY, state);
    }
    async saveSession(snapshot) {
        const current = this.load();
        await this.save({
            ...current,
            schemaVersion: extension_state_1.CURRENT_STATE_SCHEMA_VERSION,
            previousSession: snapshot ? persistedSession(snapshot) : undefined,
        });
    }
    async addRecent(snapshot, limit = 5) {
        const current = this.load();
        const next = recentComparison(snapshot);
        const key = `${next.leftUri}\n${next.rightUri}`;
        const recentComparisons = [
            next,
            ...current.recentComparisons.filter((item) => `${item.leftUri}\n${item.rightUri}` !== key),
        ].slice(0, Math.min(20, Math.max(1, limit)));
        await this.save({ ...current, recentComparisons });
    }
    async setUnmanagedWarningAcknowledged(value) {
        const current = this.load();
        await this.save({ ...current, unmanagedWarningAcknowledged: value });
    }
    loadPendingRestoreFormats() {
        return parsePendingRestoreFormats(this.memento.get(exports.PENDING_RESTORE_FORMATS_KEY)).records;
    }
    async readStateFile(uri) {
        if (!this.workspaceFs)
            return undefined;
        let lastError;
        for (let attempt = 0; attempt < READ_RETRIES; attempt += 1) {
            try {
                const bytes = await this.workspaceFs.readFile(uri);
                const parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes));
                if (!Array.isArray(parsed)) {
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.records)) {
                        throw new Error('invalid pending restore format state');
                    }
                }
                return parsePendingRestoreFormats(parsed);
            }
            catch (error) {
                lastError = error;
                if (isMissingError(error))
                    return undefined;
                if (attempt + 1 < READ_RETRIES)
                    await new Promise((resolve) => setTimeout(resolve, READ_RETRY_MS));
            }
        }
        void lastError;
        return undefined;
    }
    async loadPendingRestoreFormatStateFresh() {
        if (this.pendingRestoreFormatFileUri && this.pendingRestoreFormatBackupUri && this.workspaceFs) {
            const main = await this.readStateFile(this.pendingRestoreFormatFileUri);
            if (main)
                return main;
            const backup = await this.readStateFile(this.pendingRestoreFormatBackupUri);
            if (backup) {
                try {
                    await this.workspaceFs.delete(this.pendingRestoreFormatFileUri);
                }
                catch { /* missing or unreadable main */ }
                try {
                    await this.writePendingRestoreFormatState(backup, false);
                }
                catch { /* backup is still usable */ }
                return backup;
            }
        }
        return parsePendingRestoreFormats(this.memento.get(exports.PENDING_RESTORE_FORMATS_KEY));
    }
    async loadPendingRestoreFormatsFresh() {
        return this.loadPendingRestoreFormatStateFresh();
    }
    async writePendingRestoreFormatState(state, rotateBackup = true) {
        if (this.pendingRestoreFormatFileUri && this.pendingRestoreFormatBackupUri && this.workspaceFs) {
            const parentPath = this.pendingRestoreFormatFileUri.path.replace(/\/[^/]+$/, '') || '/';
            const parent = this.pendingRestoreFormatFileUri.with({ path: parentPath });
            await this.workspaceFs.createDirectory(parent);
            const temp = this.pendingRestoreFormatFileUri.with({
                path: `${this.pendingRestoreFormatFileUri.path}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`,
            });
            const bytes = new TextEncoder().encode(`${JSON.stringify(state, null, 2)}\n`);
            await this.workspaceFs.writeFile(temp, bytes);
            try {
                if (rotateBackup) {
                    try {
                        await this.workspaceFs.rename(this.pendingRestoreFormatFileUri, this.pendingRestoreFormatBackupUri, { overwrite: true });
                    }
                    catch (error) {
                        if (!isMissingError(error))
                            throw error;
                    }
                }
                await this.workspaceFs.rename(temp, this.pendingRestoreFormatFileUri, { overwrite: false });
            }
            catch (error) {
                try {
                    await this.workspaceFs.delete(temp);
                }
                catch { /* best effort */ }
                throw error;
            }
            try {
                await this.memento.update(exports.PENDING_RESTORE_FORMATS_KEY, state);
            }
            catch { /* file state is authoritative */ }
            return;
        }
        await this.memento.update(exports.PENDING_RESTORE_FORMATS_KEY, state);
    }
    mutatePendingRestoreFormats(upserts, deletedSourceUris, expected = {}) {
        let result;
        const operation = async () => {
            const current = await this.loadPendingRestoreFormatStateFresh();
            const records = new Map(current.records.map((record) => [record.sourceUri, record]));
            const conflicts = new Set();
            for (const sourceUri of deletedSourceUris) {
                const existing = records.get(sourceUri);
                if (!matchesExpected(existing, expected[sourceUri])) {
                    conflicts.add(sourceUri);
                    continue;
                }
                records.delete(sourceUri);
            }
            for (const rawRecord of upserts) {
                const existing = records.get(rawRecord.sourceUri);
                const record = {
                    ...rawRecord,
                    recordId: typeof rawRecord.recordId === 'string' && rawRecord.recordId
                        ? rawRecord.recordId
                        : existing?.recordId ?? legacyRecordId(rawRecord.sourceUri, rawRecord.savedAt),
                    revision: typeof rawRecord.revision === 'number' && Number.isSafeInteger(rawRecord.revision) && rawRecord.revision >= 1
                        ? rawRecord.revision
                        : (existing?.revision ?? 0) + 1,
                };
                if (!matchesExpected(existing, expected[record.sourceUri])) {
                    conflicts.add(record.sourceUri);
                    continue;
                }
                if (existing && (record.recordId !== existing.recordId || record.revision <= existing.revision)) {
                    conflicts.add(record.sourceUri);
                    continue;
                }
                if (!existing && record.revision !== 1) {
                    conflicts.add(record.sourceUri);
                    continue;
                }
                records.set(record.sourceUri, record);
            }
            const state = {
                schemaVersion: PENDING_RESTORE_FORMATS_SCHEMA_VERSION,
                generation: current.generation + 1,
                records: [...records.values()]
                    .sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt))
                    .slice(0, MAX_PERSISTED_RESTORE_FORMATS),
            };
            await this.writePendingRestoreFormatState(state);
            result = { state, conflicts: [...conflicts] };
        };
        const queued = this.pendingRestoreFormatQueue.then(operation, operation);
        this.pendingRestoreFormatQueue = queued.then(() => undefined, () => undefined);
        return queued.then(() => result);
    }
    resetPendingRestoreFormats(expected = {}) {
        let result;
        const operation = async () => {
            const current = await this.loadPendingRestoreFormatStateFresh();
            const conflicts = current.records
                .filter((record) => !matchesExpected(record, expected[record.sourceUri]))
                .map((record) => record.sourceUri);
            if (conflicts.length > 0) {
                result = { state: current, conflicts };
                return;
            }
            const state = {
                schemaVersion: PENDING_RESTORE_FORMATS_SCHEMA_VERSION,
                generation: current.generation + 1,
                records: [],
            };
            if (this.pendingRestoreFormatFileUri && this.pendingRestoreFormatBackupUri && this.workspaceFs) {
                for (const uri of [this.pendingRestoreFormatFileUri, this.pendingRestoreFormatBackupUri]) {
                    try {
                        await this.workspaceFs.delete(uri);
                    }
                    catch (error) {
                        if (!isMissingError(error))
                            throw error;
                    }
                }
                await this.writePendingRestoreFormatState(state, false);
            }
            else {
                await this.writePendingRestoreFormatState(state, false);
            }
            result = { state, conflicts: [] };
        };
        const queued = this.pendingRestoreFormatQueue.then(operation, operation);
        this.pendingRestoreFormatQueue = queued.then(() => undefined, () => undefined);
        return queued.then(() => result);
    }
    async savePendingRestoreFormats(records) {
        const current = await this.loadPendingRestoreFormatStateFresh();
        const normalized = parsePendingRestoreFormats({ generation: current.generation + 1, records });
        await this.writePendingRestoreFormatState(normalized);
    }
    async reset() {
        await Promise.all([
            this.memento.update(exports.WORKSPACE_STATE_KEY, extension_state_1.INITIAL_EXTENSION_STATE),
            this.memento.update(exports.PENDING_RESTORE_FORMATS_KEY, { schemaVersion: PENDING_RESTORE_FORMATS_SCHEMA_VERSION, generation: 0, records: [] }),
        ]);
    }
}
exports.WorkspaceStorage = WorkspaceStorage;
