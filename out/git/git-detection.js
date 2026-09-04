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
exports.GitDetector = void 0;
const vscode = __importStar(require("vscode"));
const localization_1 = require("../localization");
function normalizedPath(uri) {
    return uri.path.replace(/\/+$/, '');
}
function isInside(root, candidate) {
    if (root.scheme !== candidate.scheme || root.authority !== candidate.authority)
        return false;
    const rootPath = `${normalizedPath(root)}/`;
    const candidatePath = normalizedPath(candidate);
    return candidatePath === normalizedPath(root) || candidatePath.startsWith(rootPath);
}
function relativePath(root, candidate) {
    const rootPath = normalizedPath(root);
    const candidatePath = normalizedPath(candidate);
    return candidatePath.slice(rootPath.length).replace(/^\/+/, '');
}
function repositoryForUri(api, uri) {
    return [...api.repositories]
        .filter((repository) => isInside(repository.rootUri, uri))
        .sort((left, right) => normalizedPath(right.rootUri).length - normalizedPath(left.rootUri).length)[0];
}
async function isTracked(repository, filePath) {
    if (repository.getObjectDetails) {
        try {
            await repository.getObjectDetails('HEAD', filePath);
            return true;
        }
        catch {
            return false;
        }
    }
    if (repository.show) {
        try {
            await repository.show('HEAD', filePath);
            return true;
        }
        catch {
            return false;
        }
    }
    throw new Error((0, localization_1.t)('Git拡張機能の追跡確認APIを利用できません。'));
}
/** VS Code組み込みGit拡張の公開APIを利用し、シェルコマンドを実行せず管理状態を判定します。 */
class GitDetector {
    async detect(uri) {
        if (uri.scheme !== 'file')
            return 'unknown';
        const extension = vscode.extensions.getExtension('vscode.git');
        if (!extension)
            return 'unknown';
        try {
            const exports = extension.isActive ? extension.exports : await extension.activate();
            const api = exports.getAPI(1);
            const repository = repositoryForUri(api, uri);
            if (!repository)
                return 'unmanaged';
            return await isTracked(repository, relativePath(repository.rootUri, uri)) ? 'managed' : 'unmanaged';
        }
        catch {
            return 'unknown';
        }
    }
}
exports.GitDetector = GitDetector;
