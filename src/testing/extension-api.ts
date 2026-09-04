import type { ExtensionHostTestApi } from './extension-test-api';

/** Extension Hostテストと内部ヘルスチェックが共有する最小情報です。 */
export interface ExtensionHealth {
  readonly activated: true;
  readonly version: string;
  readonly productName: string;
  readonly stateSchemaVersion: number;
}

/** 正式なユーザー操作を先行公開せず、起動状態だけを検査するAPIです。 */
export interface ExtensionApi {
  getHealth(): ExtensionHealth;
  /** 明示的な自動Extension Hostテスト実行時だけ利用でき、通常のF5／Productionでは常にundefinedです。 */
  getTesting(): ExtensionHostTestApi | undefined;
}

export function createExtensionApi(
  health: ExtensionHealth,
  testing?: ExtensionHostTestApi,
): ExtensionApi {
  const frozenHealth = Object.freeze({ ...health });
  return Object.freeze({
    getHealth: () => frozenHealth,
    getTesting: () => testing,
  });
}
