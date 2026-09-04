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
exports.ExtensionOutput = exports.OUTPUT_CHANNEL_NAME = void 0;
exports.createExtensionOutput = createExtensionOutput;
const vscode = __importStar(require("vscode"));
const localization_1 = require("../localization");
exports.OUTPUT_CHANNEL_NAME = (0, localization_1.t)('かんたん左右ファイル比較');
/** 利用者向け通知と混同しない、ローカル開発ログの最小ラッパーです。 */
class ExtensionOutput {
    channel;
    disposed = false;
    constructor(channel) {
        this.channel = channel;
    }
    info(message) {
        if (!this.disposed) {
            this.channel.appendLine(`[info] ${message}`);
        }
    }
    error(message, error) {
        if (this.disposed) {
            return;
        }
        this.channel.appendLine(`[error] ${message}`);
        if (error instanceof Error) {
            this.channel.appendLine(`${error.name}: ${error.message}`);
        }
        else if (error !== undefined) {
            this.channel.appendLine(String(error));
        }
    }
    show(preserveFocus = true) {
        if (!this.disposed) {
            this.channel.show(preserveFocus);
        }
    }
    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.channel.dispose();
    }
}
exports.ExtensionOutput = ExtensionOutput;
function createExtensionOutput() {
    return new ExtensionOutput(vscode.window.createOutputChannel(exports.OUTPUT_CHANNEL_NAME));
}
