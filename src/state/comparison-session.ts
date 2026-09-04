import * as vscode from 'vscode';
import { t } from '../localization';
import { createComparisonTitle, createFileIdentity, isSameUri } from '../files/file-identity';
import type {
  ComparisonMode,
  ComparisonSide,
  ComparisonSnapshot,
  FileIdentity,
} from '../shared-types';
import type { PersistedComparisonSession } from './extension-state';

function normalizeLabel(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 40) : undefined;
}

/** 1セッション限定の左右状態です。 */
export class ComparisonSession {
  private leftValue: FileIdentity | undefined;
  private rightValue: FileIdentity | undefined;
  private leftLabelValue: string | undefined;
  private rightLabelValue: string | undefined;
  private modeValue: ComparisonMode = 'normal';

  public get left(): FileIdentity | undefined {
    return this.leftValue;
  }

  public get right(): FileIdentity | undefined {
    return this.rightValue;
  }

  public get leftLabel(): string | undefined {
    return this.leftLabelValue;
  }

  public get rightLabel(): string | undefined {
    return this.rightLabelValue;
  }

  public get mode(): ComparisonMode {
    return this.modeValue;
  }

  public setMode(mode: ComparisonMode): void {
    this.modeValue = mode;
  }

  public setLeft(uri: vscode.Uri): void {
    const next = createFileIdentity(uri);
    const changed = !this.leftValue || !isSameUri(this.leftValue.uri, next.uri);
    this.leftValue = next;
    if (changed) this.leftLabelValue = undefined;
    if (this.rightValue && isSameUri(this.leftValue.uri, this.rightValue.uri)) {
      this.rightValue = undefined;
      this.rightLabelValue = undefined;
    }
  }

  public setRight(uri: vscode.Uri): void {
    if (!this.leftValue) throw new Error(t('先にL・左側ファイルを設定してください。'));
    if (isSameUri(this.leftValue.uri, uri)) {
      throw new Error(t('L・左側とR・右側に同じファイルは設定できません。'));
    }
    const next = createFileIdentity(uri);
    const changed = !this.rightValue || !isSameUri(this.rightValue.uri, next.uri);
    this.rightValue = next;
    if (changed) this.rightLabelValue = undefined;
  }

  public replaceUri(side: ComparisonSide, uri: vscode.Uri): void {
    const next = createFileIdentity(uri);
    if (side === 'left') {
      if (this.rightValue && isSameUri(this.rightValue.uri, next.uri)) {
        throw new Error(t('移動後のL・左側がR・右側と同じファイルになるため、比較を続けられません。'));
      }
      this.leftValue = next;
      return;
    }
    if (this.leftValue && isSameUri(this.leftValue.uri, next.uri)) {
      throw new Error(t('移動後のR・右側がL・左側と同じファイルになるため、比較を続けられません。'));
    }
    this.rightValue = next;
  }

  /** 1つのファイル操作でL・Rが同時に移動した場合、検証後に両側を原子的に置き換えます。 */
  public replaceUris(value: { readonly left?: vscode.Uri; readonly right?: vscode.Uri }): void {
    const nextLeft = value.left ? createFileIdentity(value.left) : this.leftValue;
    const nextRight = value.right ? createFileIdentity(value.right) : this.rightValue;
    if (nextLeft && nextRight && isSameUri(nextLeft.uri, nextRight.uri)) {
      throw new Error(t('移動後のL・左側とR・右側が同じファイルになるため、比較を続けられません。'));
    }
    this.leftValue = nextLeft;
    this.rightValue = nextRight;
  }

  public restore(value: PersistedComparisonSession): void {
    const left = vscode.Uri.parse(value.leftUri, true);
    const right = vscode.Uri.parse(value.rightUri, true);
    if (isSameUri(left, right)) throw new Error(t('保存された左右が同じファイルです。'));
    this.leftValue = createFileIdentity(left);
    this.rightValue = createFileIdentity(right);
    this.leftLabelValue = normalizeLabel(value.leftLabel);
    this.rightLabelValue = normalizeLabel(value.rightLabel);
    this.modeValue = value.mode;
  }

  public setLabel(side: ComparisonSide, value: string | undefined): void {
    if (side === 'left') {
      if (!this.leftValue) throw new Error(t('L・左側ファイルが設定されていません。'));
      this.leftLabelValue = normalizeLabel(value);
      return;
    }
    if (!this.rightValue) throw new Error(t('R・右側ファイルが設定されていません。'));
    this.rightLabelValue = normalizeLabel(value);
  }

  public clearSide(side: ComparisonSide): void {
    if (side === 'left') {
      this.leftValue = undefined;
      this.leftLabelValue = undefined;
    } else {
      this.rightValue = undefined;
      this.rightLabelValue = undefined;
    }
  }

  public snapshot(): ComparisonSnapshot {
    if (!this.leftValue || !this.rightValue) {
      throw new Error(t('L・左側とR・右側の両方を設定してください。'));
    }
    return {
      left: this.leftValue,
      right: this.rightValue,
      leftLabel: this.leftLabelValue,
      rightLabel: this.rightLabelValue,
      sameDisplayName: this.leftValue.displayName === this.rightValue.displayName,
      mode: this.modeValue,
      title: createComparisonTitle(
        this.leftValue,
        this.rightValue,
        this.leftLabelValue,
        this.rightLabelValue,
      ),
    };
  }

  public swap(): void {
    if (!this.leftValue || !this.rightValue) {
      throw new Error(t('左右を入れ替えるには両方のファイルが必要です。'));
    }
    const previousLeft = this.leftValue;
    const previousLeftLabel = this.leftLabelValue;
    this.leftValue = this.rightValue;
    this.leftLabelValue = this.rightLabelValue;
    this.rightValue = previousLeft;
    this.rightLabelValue = previousLeftLabel;
  }

  public clear(): void {
    this.leftValue = undefined;
    this.rightValue = undefined;
    this.leftLabelValue = undefined;
    this.rightLabelValue = undefined;
    this.modeValue = 'normal';
  }
}
