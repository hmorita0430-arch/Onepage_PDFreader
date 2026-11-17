/**
 * 目に優しい表示(この端末内の設定。端末間では同期しない)。
 * - 暖色フィルタ: 画面全体に薄い暖色を重ね、青い光を弱める(0〜100%)
 * - 紙の色: ページ(撮影写真)の白い部分を、クリーム色に寄せる(0〜100%)
 * Androidのシステムの「夜間モード」「目の保護」とは別。併用すると、暖色が強くなりすぎる。
 */
export interface EyeComfort {
  /** 暖色フィルタの強さ(0〜100) */
  warm: number;
  /** 紙の色の強さ(0〜100) */
  paper: number;
}

export const EYE_KEY = 'eye-comfort:v1';
export const DEFAULT_EYE: EyeComfort = { warm: 0, paper: 0 };
/** 100%のときの、重ねる色の濃さ(不透明度)。強すぎて、読めなくならないように、上限を設ける */
export const MAX_WARM_OPACITY = 0.5;
export const MAX_PAPER_OPACITY = 0.9;

export const clampPct = (v: unknown): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.round(Math.max(0, Math.min(100, n)));
};

export function parseEyeComfort(raw: string | null | undefined): EyeComfort {
  if (!raw) return { ...DEFAULT_EYE };
  try {
    const v = JSON.parse(raw) as Partial<EyeComfort> & { on?: boolean };
    // 以前の版で「切っている」状態で保存されたものは、強さ0(オフ)として読む
    if (v.on === false) return { ...DEFAULT_EYE };
    return { warm: clampPct(v.warm), paper: clampPct(v.paper) };
  } catch {
    return { ...DEFAULT_EYE };
  }
}

/** 効いているか(どちらかの強さが0より大きい) */
export const isEyeActive = (e: EyeComfort): boolean => e.warm > 0 || e.paper > 0;

/** 画面に重ねる色の不透明度(0〜上限) */
export function warmOpacity(e: EyeComfort): number {
  return Math.round((e.warm / 100) * MAX_WARM_OPACITY * 1000) / 1000;
}
export function paperOpacity(e: EyeComfort): number {
  return Math.round((e.paper / 100) * MAX_PAPER_OPACITY * 1000) / 1000;
}

/** スライダーを動かした */
export function withStrength(e: EyeComfort, key: 'warm' | 'paper', value: number): EyeComfort {
  return { ...e, [key]: clampPct(value) };
}

export function loadEyeComfort(): EyeComfort {
  try {
    return parseEyeComfort(localStorage.getItem(EYE_KEY));
  } catch {
    return { ...DEFAULT_EYE };
  }
}

export function saveEyeComfort(e: EyeComfort): void {
  try {
    localStorage.setItem(EYE_KEY, JSON.stringify({ warm: clampPct(e.warm), paper: clampPct(e.paper) }));
  } catch {
    /* 保存できなくても、この回は反映される */
  }
}
