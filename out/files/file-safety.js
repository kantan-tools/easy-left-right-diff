"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.READONLY_LINE_LIMIT = exports.READONLY_SIZE_LIMIT = exports.NORMAL_SIZE_LIMIT = void 0;
exports.assessFileBytes = assessFileBytes;
exports.assessFile = assessFile;
exports.formatByteSize = formatByteSize;
const vscode = __importStar(require("vscode"));
const localization_1 = require("../localization");
exports.NORMAL_SIZE_LIMIT = 5 * 1024 * 1024;
exports.READONLY_SIZE_LIMIT = 20 * 1024 * 1024;
exports.READONLY_LINE_LIMIT = 200_000;
function hasUtf8Bom(bytes) {
    return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}
function containsNullByte(bytes) {
    return bytes.some((value) => value === 0);
}
function decodeUtf8(bytes) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        return undefined;
    }
}
function countLines(text) {
    if (text.length === 0)
        return 1;
    let count = 1;
    for (let index = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 10)
            count += 1;
    }
    return count;
}
/** バイト列だけから安全判定できる純粋関数です。 */
function assessFileBytes(bytes) {
    const sizeBytes = bytes.byteLength;
    const reasons = [];
    if (containsNullByte(bytes)) {
        return {
            sizeBytes,
            lineCount: 0,
            encoding: 'binary',
            level: 'unsupported',
            reasons: [(0, localization_1.t)('バイナリデータを検出しました。')],
            readonlyPermission: false,
        };
    }
    const text = decodeUtf8(bytes);
    if (text === undefined) {
        return {
            sizeBytes,
            lineCount: 0,
            encoding: 'non-utf8',
            level: 'readonly',
            reasons: [(0, localization_1.t)('UTF-8として安全に読み取れないため、編集を無効にします。')],
            readonlyPermission: false,
        };
    }
    const lineCount = countLines(text);
    let level = 'normal';
    if (sizeBytes > exports.READONLY_SIZE_LIMIT) {
        level = 'readonly';
        reasons.push((0, localization_1.t)('20MBを超えるため、変更箇所コピーとファイル全体コピーを無効にします。'));
    }
    else if (sizeBytes > exports.NORMAL_SIZE_LIMIT) {
        level = 'warning';
        reasons.push((0, localization_1.t)('5MBを超えるため、差分表示や差分特定に時間がかかる可能性があります。'));
    }
    if (lineCount > exports.READONLY_LINE_LIMIT) {
        level = 'readonly';
        reasons.push((0, localization_1.t)('行数が安全上限を超えるため、読み取り専用比較へ切り替えます。'));
    }
    return {
        sizeBytes,
        lineCount,
        encoding: hasUtf8Bom(bytes) ? 'utf8-bom' : 'utf8',
        level,
        reasons,
        readonlyPermission: false,
    };
}
/** VS Code FileSystem APIだけを使って対象ファイルを評価します。 */
async function assessFile(uri) {
    const [bytes, stat] = await Promise.all([
        vscode.workspace.fs.readFile(uri),
        vscode.workspace.fs.stat(uri),
    ]);
    const base = assessFileBytes(bytes);
    const readonlyPermission = Boolean(stat.permissions !== undefined
        && (stat.permissions & vscode.FilePermission.Readonly) === vscode.FilePermission.Readonly);
    if (!readonlyPermission)
        return base;
    const reasons = [...base.reasons, (0, localization_1.t)('ファイルシステムが読み取り専用としているため、編集を無効にします。')];
    return {
        ...base,
        level: base.level === 'unsupported' ? 'unsupported' : 'readonly',
        reasons,
        readonlyPermission: true,
    };
}
function formatByteSize(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    const kib = bytes / 1024;
    if (kib < 1024)
        return `${kib.toFixed(1)} KB`;
    return `${(kib / 1024).toFixed(1)} MB`;
}
