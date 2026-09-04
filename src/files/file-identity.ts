import * as vscode from 'vscode';
import type { FileIdentity } from '../shared-types';
import { t } from '../localization';

/** URI末尾のファイル名を、OS固有パス連結に依存せず取得します。 */
export function getUriBaseName(uri: vscode.Uri): string {
  const normalized = uri.path.replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function isWindowsFileUri(uri: vscode.Uri): boolean {
  const normalized = uri.path.replace(/\\/g, '/');
  return uri.scheme.toLowerCase() === 'file'
    && (Boolean(uri.authority) || /^\/[A-Za-z]:(?:\/|$)/.test(normalized));
}

/** 同一ファイル判定で使う正規キーです。Windowsのドライブ・UNCだけはパス全体を大文字小文字同一視します。 */
export function uriIdentityKey(uri: vscode.Uri): string {
  const scheme = uri.scheme.toLowerCase();
  const windowsFile = isWindowsFileUri(uri);
  const authority = windowsFile ? uri.authority.toLowerCase() : uri.authority;
  const path = windowsFile ? uri.path.replace(/\\/g, '/').toLowerCase() : uri.path;
  return `${scheme}://${authority}${path}?${uri.query}#${uri.fragment}`;
}

/** URI同一性をOSのファイル名規則を含めて判定します。 */
export function isSameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return uriIdentityKey(left) === uriIdentityKey(right);
}

function comparableUriPath(uri: vscode.Uri): string {
  const normalized = uri.path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return isWindowsFileUri(uri) ? normalized.toLowerCase() : normalized;
}

function comparableAuthority(uri: vscode.Uri): string {
  return isWindowsFileUri(uri) ? uri.authority.toLowerCase() : uri.authority;
}

/** URIが同じURIまたはその子孫かを、scheme・authority・path境界で判定します。 */
export function isSameOrDescendantUri(uri: vscode.Uri, ancestor: vscode.Uri): boolean {
  if (uri.scheme.toLowerCase() !== ancestor.scheme.toLowerCase() || comparableAuthority(uri) !== comparableAuthority(ancestor)) return false;
  const childPath = comparableUriPath(uri);
  const parentPath = comparableUriPath(ancestor);
  return childPath === parentPath || childPath.startsWith(parentPath === '/' ? '/' : `${parentPath}/`);
}

/** 親URIの改名・移動を、子ファイルURIへ安全に反映します。 */
export function replaceUriAncestor(uri: vscode.Uri, oldAncestor: vscode.Uri, newAncestor: vscode.Uri): vscode.Uri | undefined {
  if (!isSameOrDescendantUri(uri, oldAncestor)) return undefined;
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

export interface UriRenamePair {
  readonly oldUri: vscode.Uri;
  readonly newUri: vscode.Uri;
}

/** 複数の改名候補から最も内側の親を選び、子ファイルの新URIを1回だけ計算します。 */
export function mapUriThroughRenames(uri: vscode.Uri, renames: readonly UriRenamePair[]): vscode.Uri | undefined {
  const candidates = renames
    .filter((renamed) => isSameOrDescendantUri(uri, renamed.oldUri))
    .sort((a, b) => b.oldUri.path.length - a.oldUri.path.length);
  const match = candidates[0];
  return match ? replaceUriAncestor(uri, match.oldUri, match.newUri) : undefined;
}

/** 比較対象ファイルのワークスペース名・相対パスを正式APIから構築します。 */
export function createFileIdentity(uri: vscode.Uri): FileIdentity {
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

function normalizeTitlePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function splitPath(value: string): string[] {
  return normalizeTitlePath(value).split('/').filter(Boolean);
}

function withLabel(value: string, label: string | undefined): string {
  return label ? t('{0}｜{1}', label, value) : value;
}

function compactSuffix(leftSegments: readonly string[], rightSegments: readonly string[]): { left: string; right: string } {
  const leftFile = leftSegments.at(-1) ?? '';
  const rightFile = rightSegments.at(-1) ?? '';
  if (leftFile !== rightFile) return { left: leftFile, right: rightFile };

  const leftDirs = leftSegments.slice(0, -1);
  const rightDirs = rightSegments.slice(0, -1);
  let commonTail = 0;
  while (
    commonTail < leftDirs.length
    && commonTail < rightDirs.length
    && leftDirs[leftDirs.length - 1 - commonTail] === rightDirs[rightDirs.length - 1 - commonTail]
  ) {
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
export function createDistinguishingLocations(
  left: FileIdentity,
  right: FileIdentity,
): { left: string; right: string } {
  const relative = compactSuffix(splitPath(left.relativePath), splitPath(right.relativePath));
  if (relative.left !== relative.right) return relative;

  const leftWorkspace = left.workspaceName ?? t('ワークスペース外');
  const rightWorkspace = right.workspaceName ?? t('ワークスペース外');
  if (leftWorkspace !== rightWorkspace) {
    return {
      left: `${leftWorkspace}/${relative.left}`,
      right: `${rightWorkspace}/${relative.right}`,
    };
  }

  const absolute = compactSuffix(splitPath(left.uri.fsPath), splitPath(right.uri.fsPath));
  if (absolute.left !== absolute.right) return absolute;
  return {
    left: `${leftWorkspace}/${relative.left}`,
    right: `${rightWorkspace}/${relative.right}`,
  };
}

/**
 * 標準差分タイトルは改行・部分太字を保証できないため、L/R境界を強くし、共通パスを省いた短い表示にします。
 */
export function createComparisonTitle(
  left: FileIdentity,
  right: FileIdentity,
  leftLabel?: string,
  rightLabel?: string,
): string {
  const distinct = createDistinguishingLocations(left, right);
  return t('【左右比較】┃L・左側┃〈{0}〉　⇔　┃R・右側┃〈{1}〉　║', withLabel(distinct.left, leftLabel), withLabel(distinct.right, rightLabel));
}

/** 左右確認ビューや通知で使う、ワークスペースと場所を分けた表示です。 */
export function createIdentityDescription(identity: FileIdentity): string {
  const workspace = identity.workspaceName ?? t('ワークスペース外');
  return t('{0}\n{1}', workspace, identity.relativePath);
}
