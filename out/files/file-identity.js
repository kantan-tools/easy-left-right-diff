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
exports.getUriBaseName = getUriBaseName;
exports.uriIdentityKey = uriIdentityKey;
exports.isSameUri = isSameUri;
exports.isSameOrDescendantUri = isSameOrDescendantUri;
exports.replaceUriAncestor = replaceUriAncestor;
exports.mapUriThroughRenames = mapUriThroughRenames;
exports.createFileIdentity = createFileIdentity;
exports.createDistinguishingLocations = createDistinguishingLocations;
exports.createComparisonTitle = createComparisonTitle;
exports.createIdentityDescription = createIdentityDescription;
const vscode = __importStar(require("vscode"));
const localization_1 = require("../localization");
/** URI末尾のファイル名を、OS固有パス連結に依存せず取得します。 */
function getUriBaseName(uri) {
    const normalized = uri.path.replace(/\/+$/, '');
    const index = normalized.lastIndexOf('/');
    return index >= 0 ? normalized.slice(index + 1) : normalized;
}
function isWindowsFileUri(uri) {
    const normalized = uri.path.replace(/\\/g, '/');
    return uri.scheme.toLowerCase() === 'file'
        && (Boolean(uri.authority) || /^\/[A-Za-z]:(?:\/|$)/.test(normalized));
}
/** 同一ファイル判定で使う正規キーです。Windowsのドライブ・UNCだけはパス全体を大文字小文字同一視します。 */
function uriIdentityKey(uri) {
    const scheme = uri.scheme.toLowerCase();
    const windowsFile = isWindowsFileUri(uri);
    const authority = windowsFile ? uri.authority.toLowerCase() : uri.authority;
    const path = windowsFile ? uri.path.replace(/\\/g, '/').toLowerCase() : uri.path;
    return `${scheme}://${authority}${path}?${uri.query}#${uri.fragment}`;
}
/** URI同一性をOSのファイル名規則を含めて判定します。 */
function isSameUri(left, right) {
    return uriIdentityKey(left) === uriIdentityKey(right);
}
function comparableUriPath(uri) {
    const normalized = uri.path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
    return isWindowsFileUri(uri) ? normalized.toLowerCase() : normalized;
}
function comparableAuthority(uri) {
    return isWindowsFileUri(uri) ? uri.authority.toLowerCase() : uri.authority;
}
/** URIが同じURIまたはその子孫かを、scheme・authority・path境界で判定します。 */
function isSameOrDescendantUri(uri, ancestor) {
    if (uri.scheme.toLowerCase() !== ancestor.scheme.toLowerCase() || comparableAuthority(uri) !== comparableAuthority(ancestor))
        return false;
    const childPath = comparableUriPath(uri);
    const parentPath = comparableUriPath(ancestor);
    return childPath === parentPath || childPath.startsWith(parentPath === '/' ? '/' : `${parentPath}/`);
}
/** 親URIの改名・移動を、子ファイルURIへ安全に反映します。 */
function replaceUriAncestor(uri, oldAncestor, newAncestor) {
    if (!isSameOrDescendantUri(uri, oldAncestor))
        return undefined;
    const oldPath = comparableUriPath(oldAncestor);
    const actualOldPath = oldAncestor.path.replace(/\/+$/, '') || '/';
    const suffix = uri.path.slice(actualOldPath.length);
    const nextBase = newAncestor.path.replace(/\/+$/, '') || '/';
    // 比較用の小文字化は判定だけに使い、返却URIでは元の大文字小文字とquery/fragmentを維持します。
    void oldPath;
    return uri.with({
        scheme: newAncestor.scheme,
        authority: newAncestor.authority,
        path: `${nextBase}${suffix}`,
    });
}
/** 複数の改名候補から最も内側の親を選び、子ファイルの新URIを1回だけ計算します。 */
function mapUriThroughRenames(uri, renames) {
    const candidates = renames
        .filter((renamed) => isSameOrDescendantUri(uri, renamed.oldUri))
        .sort((a, b) => b.oldUri.path.length - a.oldUri.path.length);
    const match = candidates[0];
    return match ? replaceUriAncestor(uri, match.oldUri, match.newUri) : undefined;
}
/** 比較対象ファイルのワークスペース名・相対パスを正式APIから構築します。 */
function createFileIdentity(uri) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const relativePath = folder
        ? vscode.workspace.asRelativePath(uri, false)
        : uri.fsPath;
    return {
        uri,
        workspaceName: folder?.name,
        workspaceRootUri: folder?.uri,
        relativePath,
        displayName: getUriBaseName(uri),
        outsideWorkspace: folder === undefined,
    };
}
function normalizeTitlePath(value) {
    return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}
function splitPath(value) {
    return normalizeTitlePath(value).split('/').filter(Boolean);
}
function withLabel(value, label) {
    return label ? (0, localization_1.t)('{0}｜{1}', label, value) : value;
}
function compactSuffix(leftSegments, rightSegments) {
    const leftFile = leftSegments.at(-1) ?? '';
    const rightFile = rightSegments.at(-1) ?? '';
    if (leftFile !== rightFile)
        return { left: leftFile, right: rightFile };
    const leftDirs = leftSegments.slice(0, -1);
    const rightDirs = rightSegments.slice(0, -1);
    let commonTail = 0;
    while (commonTail < leftDirs.length
        && commonTail < rightDirs.length
        && leftDirs[leftDirs.length - 1 - commonTail] === rightDirs[rightDirs.length - 1 - commonTail]) {
        commonTail += 1;
    }
    const leftStart = Math.max(0, leftDirs.length - commonTail - 1);
    const rightStart = Math.max(0, rightDirs.length - commonTail - 1);
    const leftValue = [...leftDirs.slice(leftStart), leftFile].filter(Boolean).join('/');
    const rightValue = [...rightDirs.slice(rightStart), rightFile].filter(Boolean).join('/');
    return { left: leftValue || leftFile, right: rightValue || rightFile };
}
/**
 * 左右の共通部分をできるだけ省き、見分けるために必要な短い場所だけを返します。
 * 太字などを使えない標準差分タイトルでも、違う部分が先に見えることを目的とします。
 */
function createDistinguishingLocations(left, right) {
    const relative = compactSuffix(splitPath(left.relativePath), splitPath(right.relativePath));
    if (relative.left !== relative.right)
        return relative;
    const leftWorkspace = left.workspaceName ?? (0, localization_1.t)('ワークスペース外');
    const rightWorkspace = right.workspaceName ?? (0, localization_1.t)('ワークスペース外');
    if (leftWorkspace !== rightWorkspace) {
        return {
            left: `${leftWorkspace}/${relative.left}`,
            right: `${rightWorkspace}/${relative.right}`,
        };
    }
    const absolute = compactSuffix(splitPath(left.uri.fsPath), splitPath(right.uri.fsPath));
    if (absolute.left !== absolute.right)
        return absolute;
    return {
        left: `${leftWorkspace}/${relative.left}`,
        right: `${rightWorkspace}/${relative.right}`,
    };
}
/**
 * 標準差分タイトルは改行・部分太字を保証できないため、L/R境界を強くし、共通パスを省いた短い表示にします。
 */
function createComparisonTitle(left, right, leftLabel, rightLabel) {
    const distinct = createDistinguishingLocations(left, right);
    return (0, localization_1.t)('【左右比較】┃L・左側┃〈{0}〉　⇔　┃R・右側┃〈{1}〉　║', withLabel(distinct.left, leftLabel), withLabel(distinct.right, rightLabel));
}
/** 左右確認ビューや通知で使う、ワークスペースと場所を分けた表示です。 */
function createIdentityDescription(identity) {
    const workspace = identity.workspaceName ?? (0, localization_1.t)('ワークスペース外');
    return (0, localization_1.t)('{0}\n{1}', workspace, identity.relativePath);
}
