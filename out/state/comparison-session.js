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
exports.ComparisonSession = void 0;
const vscode = __importStar(require("vscode"));
const localization_1 = require("../localization");
const file_identity_1 = require("../files/file-identity");
function normalizeLabel(value) {
    const normalized = value?.trim();
    return normalized ? normalized.slice(0, 40) : undefined;
}
/** 1セッション限定の左右状態です。 */
class ComparisonSession {
    leftValue;
    rightValue;
    leftLabelValue;
    rightLabelValue;
    modeValue = 'normal';
    get left() {
        return this.leftValue;
    }
    get right() {
        return this.rightValue;
    }
    get leftLabel() {
        return this.leftLabelValue;
    }
    get rightLabel() {
        return this.rightLabelValue;
    }
    get mode() {
        return this.modeValue;
    }
    setMode(mode) {
        this.modeValue = mode;
    }
    setLeft(uri) {
        const next = (0, file_identity_1.createFileIdentity)(uri);
        const changed = !this.leftValue || !(0, file_identity_1.isSameUri)(this.leftValue.uri, next.uri);
        this.leftValue = next;
        if (changed)
            this.leftLabelValue = undefined;
        if (this.rightValue && (0, file_identity_1.isSameUri)(this.leftValue.uri, this.rightValue.uri)) {
            this.rightValue = undefined;
            this.rightLabelValue = undefined;
        }
    }
    setRight(uri) {
        if (!this.leftValue)
            throw new Error((0, localization_1.t)('先にL・左側ファイルを設定してください。'));
        if ((0, file_identity_1.isSameUri)(this.leftValue.uri, uri)) {
            throw new Error((0, localization_1.t)('L・左側とR・右側に同じファイルは設定できません。'));
        }
        const next = (0, file_identity_1.createFileIdentity)(uri);
        const changed = !this.rightValue || !(0, file_identity_1.isSameUri)(this.rightValue.uri, next.uri);
        this.rightValue = next;
        if (changed)
            this.rightLabelValue = undefined;
    }
    replaceUri(side, uri) {
        const next = (0, file_identity_1.createFileIdentity)(uri);
        if (side === 'left') {
            if (this.rightValue && (0, file_identity_1.isSameUri)(this.rightValue.uri, next.uri)) {
                throw new Error((0, localization_1.t)('移動後のL・左側がR・右側と同じファイルになるため、比較を続けられません。'));
            }
            this.leftValue = next;
            return;
        }
        if (this.leftValue && (0, file_identity_1.isSameUri)(this.leftValue.uri, next.uri)) {
            throw new Error((0, localization_1.t)('移動後のR・右側がL・左側と同じファイルになるため、比較を続けられません。'));
        }
        this.rightValue = next;
    }
    /** 1つのファイル操作でL・Rが同時に移動した場合、検証後に両側を原子的に置き換えます。 */
    replaceUris(value) {
        const nextLeft = value.left ? (0, file_identity_1.createFileIdentity)(value.left) : this.leftValue;
        const nextRight = value.right ? (0, file_identity_1.createFileIdentity)(value.right) : this.rightValue;
        if (nextLeft && nextRight && (0, file_identity_1.isSameUri)(nextLeft.uri, nextRight.uri)) {
            throw new Error((0, localization_1.t)('移動後のL・左側とR・右側が同じファイルになるため、比較を続けられません。'));
        }
        this.leftValue = nextLeft;
        this.rightValue = nextRight;
    }
    restore(value) {
        const left = vscode.Uri.parse(value.leftUri, true);
        const right = vscode.Uri.parse(value.rightUri, true);
        if ((0, file_identity_1.isSameUri)(left, right))
            throw new Error((0, localization_1.t)('保存された左右が同じファイルです。'));
        this.leftValue = (0, file_identity_1.createFileIdentity)(left);
        this.rightValue = (0, file_identity_1.createFileIdentity)(right);
        this.leftLabelValue = normalizeLabel(value.leftLabel);
        this.rightLabelValue = normalizeLabel(value.rightLabel);
        this.modeValue = value.mode;
    }
    setLabel(side, value) {
        if (side === 'left') {
            if (!this.leftValue)
                throw new Error((0, localization_1.t)('L・左側ファイルが設定されていません。'));
            this.leftLabelValue = normalizeLabel(value);
            return;
        }
        if (!this.rightValue)
            throw new Error((0, localization_1.t)('R・右側ファイルが設定されていません。'));
        this.rightLabelValue = normalizeLabel(value);
    }
    clearSide(side) {
        if (side === 'left') {
            this.leftValue = undefined;
            this.leftLabelValue = undefined;
        }
        else {
            this.rightValue = undefined;
            this.rightLabelValue = undefined;
        }
    }
    snapshot() {
        if (!this.leftValue || !this.rightValue) {
            throw new Error((0, localization_1.t)('L・左側とR・右側の両方を設定してください。'));
        }
        return {
            left: this.leftValue,
            right: this.rightValue,
            leftLabel: this.leftLabelValue,
            rightLabel: this.rightLabelValue,
            sameDisplayName: this.leftValue.displayName === this.rightValue.displayName,
            mode: this.modeValue,
            title: (0, file_identity_1.createComparisonTitle)(this.leftValue, this.rightValue, this.leftLabelValue, this.rightLabelValue),
        };
    }
    swap() {
        if (!this.leftValue || !this.rightValue) {
            throw new Error((0, localization_1.t)('左右を入れ替えるには両方のファイルが必要です。'));
        }
        const previousLeft = this.leftValue;
        const previousLeftLabel = this.leftLabelValue;
        this.leftValue = this.rightValue;
        this.leftLabelValue = this.rightLabelValue;
        this.rightValue = previousLeft;
        this.rightLabelValue = previousLeftLabel;
    }
    clear() {
        this.leftValue = undefined;
        this.rightValue = undefined;
        this.leftLabelValue = undefined;
        this.rightLabelValue = undefined;
        this.modeValue = 'normal';
    }
}
exports.ComparisonSession = ComparisonSession;
