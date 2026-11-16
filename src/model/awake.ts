/**
 * 読書中に、画面を点けたままにする時間の設定(この端末内の設定。端末間では同期しない)。
 * Webアプリは、Androidの自動消灯の時間そのものは変えられない。代わりに、画面を点けたままにする機能
 * (Screen Wake Lock)を使い、最後の操作から一定時間は暗くならないようにする。過ぎたら、端末の設定に戻る。
 */
export type AwakeMode = 'standard' | '5' | '15' | '30' | 'always';

export const AWAKE_KEY = 'awake:v1';
export const DEFAULT_AWAKE: AwakeMode = '15';

export const AWAKE_OPTIONS: ReadonlyArray<{ value: AwakeMode; label: string }> = [
  { value: 'standard', label: '標準(端末の設定どおり)' },
  { value: '5', label: '5分' },
  { value: '15', label: '15分' },
  { value: '30', label: '30分' },
  { value: 'always', label: '本を開いている間は、ずっと' },
];

export function parseAwakeMode(raw: string | null | undefined): AwakeMode {
  return AWAKE_OPTIONS.some((o) => o.value === raw) ? (raw as AwakeMode) : DEFAULT_AWAKE;
}

/** 最後の操作から、点けておく時間(ミリ秒)。null = 時間で戻さない(ずっと)、0 = 点けておかない(標準) */
export function awakeMs(mode: AwakeMode): number | null {
  switch (mode) {
    case 'standard':
      return 0;
    case 'always':
      return null;
    default:
      return Number(mode) * 60_000;
  }
}

export function loadAwakeMode(): AwakeMode {
  try {
    return parseAwakeMode(localStorage.getItem(AWAKE_KEY));
  } catch {
    return DEFAULT_AWAKE;
  }
}

export function saveAwakeMode(mode: AwakeMode): void {
  try {
    localStorage.setItem(AWAKE_KEY, mode);
  } catch {
    /* 保存できなくても、この回は反映される */
  }
}
