import * as vscode from 'vscode';
import { t } from '../localization';
import type { GitManagementStatus } from '../shared-types';

interface GitRepositoryLike {
  readonly rootUri: vscode.Uri;
  getObjectDetails?(treeish: string, path: string): Promise<unknown>;
  show?(ref: string, path: string): Promise<string>;
}

interface GitApiLike {
  readonly repositories: readonly GitRepositoryLike[];
}

interface GitExtensionExportsLike {
  getAPI(version: 1): GitApiLike;
}

function normalizedPath(uri: vscode.Uri): string {
  return uri.path.replace(/\/+$/, '');
}

function isInside(root: vscode.Uri, candidate: vscode.Uri): boolean {
  if (root.scheme !== candidate.scheme || root.authority !== candidate.authority) return false;
  const rootPath = `${normalizedPath(root)}/`;
  const candidatePath = normalizedPath(candidate);
  return candidatePath === normalizedPath(root) || candidatePath.startsWith(rootPath);
}

function relativePath(root: vscode.Uri, candidate: vscode.Uri): string {
  const rootPath = normalizedPath(root);
  const candidatePath = normalizedPath(candidate);
  return candidatePath.slice(rootPath.length).replace(/^\/+/, '');
}

function repositoryForUri(api: GitApiLike, uri: vscode.Uri): GitRepositoryLike | undefined {
  return [...api.repositories]
    .filter((repository) => isInside(repository.rootUri, uri))
    .sort((left, right) => normalizedPath(right.rootUri).length - normalizedPath(left.rootUri).length)[0];
}

async function isTracked(repository: GitRepositoryLike, filePath: string): Promise<boolean> {
  if (repository.getObjectDetails) {
    try {
      await repository.getObjectDetails('HEAD', filePath);
      return true;
    } catch {
      return false;
    }
  }
  if (repository.show) {
    try {
      await repository.show('HEAD', filePath);
      return true;
    } catch {
      return false;
    }
  }
  throw new Error(t('Git拡張機能の追跡確認APIを利用できません。'));
}

/** VS Code組み込みGit拡張の公開APIを利用し、シェルコマンドを実行せず管理状態を判定します。 */
export class GitDetector {
  public async detect(uri: vscode.Uri): Promise<GitManagementStatus> {
    if (uri.scheme !== 'file') return 'unknown';
    const extension = vscode.extensions.getExtension<GitExtensionExportsLike>('vscode.git');
    if (!extension) return 'unknown';
    try {
      const exports = extension.isActive ? extension.exports : await extension.activate();
      const api = exports.getAPI(1);
      const repository = repositoryForUri(api, uri);
      if (!repository) return 'unmanaged';
      return await isTracked(repository, relativePath(repository.rootUri, uri)) ? 'managed' : 'unmanaged';
    } catch {
      return 'unknown';
    }
  }
}
