/**
 * タッチ(指)で描くときの、位置の補正(この端末内の設定)。
 * 指の接触面の中心と、狙っている位置の差を、あらかじめ測っておき、描く点にその分を足す。
 * 純粋関数+端末内への保存。座標は画面のピクセル(CSSピクセル)。
 */
export interface Offset {
  x: number;
  y: number;
}

export const NO_OFFSET: Offset = { x: 0, y: 0 };
/** 補正の上限(これを超える補正は、測定の誤りか、操作の誤りと考える) */
export const MAX_OFFSET_PX = 60;
export const OFFSET_KEY = 'draw-offset:v1';

const round1 = (v: number) => Math.round(v * 10) / 10;

export function clampOffset(o: Offset): Offset {
  const c = (v: number) => (Number.isFinite(v) ? round1(Math.max(-MAX_OFFSET_PX, Math.min(MAX_OFFSET_PX, v))) : 0);
  return { x: c(o.x), y: c(o.y) };
}

export function isNoOffset(o: Offset): boolean {
  return o.x === 0 && o.y === 0;
}

/** 保存値を読む。壊れた値・形が違う値は「補正なし」 */
export function parseOffset(raw: string | null | undefined): Offset {
  if (!raw) return NO_OFFSET;
  try {
    const v = JSON.parse(raw) as Partial<Offset>;
    if (typeof v.x !== 'number' || typeof v.y !== 'number') return NO_OFFSET;
    return clampOffset({ x: v.x, y: v.y });
  } catch {
    return NO_OFFSET;
  }
}

export interface Sample {
  /** 狙った位置(目印の中心) */
  aim: Offset;
  /** アプリが受け取った、触れた位置 */
  hit: Offset;
}

/** 測定した差(狙い − 触れた位置)の平均。これを、触れた位置に足せば、狙いに近づく */
export function averageOffset(samples: readonly Sample[]): Offset {
  if (samples.length === 0) return NO_OFFSET;
  let sx = 0;
  let sy = 0;
  for (const s of samples) {
    sx += s.aim.x - s.hit.x;
    sy += s.aim.y - s.hit.y;
  }
  return clampOffset({ x: sx / samples.length, y: sy / samples.length });
}

/** 測定のばらつき(各回の差が、平均からどれだけ離れているかの最大値)。大きいと、1つの補正では合わない */
export function spread(samples: readonly Sample[]): number {
  if (samples.length === 0) return 0;
  const avg = averageOffset(samples);
  let max = 0;
  for (const s of samples) {
    max = Math.max(max, Math.hypot(s.aim.x - s.hit.x - avg.x, s.aim.y - s.hit.y - avg.y));
  }
  return round1(max);
}

/** 描く点に、補正を足す */
export function applyOffset(p: Offset, o: Offset): Offset {
  return { x: p.x + o.x, y: p.y + o.y };
}

/** 画面用の説明。例: 「右へ6px・上へ9px」 */
export function describeOffset(o: Offset): string {
  if (isNoOffset(o)) return '補正なし';
  const parts: string[] = [];
  if (o.x !== 0) parts.push(`${o.x > 0 ? '右' : '左'}へ${Math.abs(o.x)}px`);
  if (o.y !== 0) parts.push(`${o.y > 0 ? '下' : '上'}へ${Math.abs(o.y)}px`);
  return parts.join('・');
}

export function loadOffset(): Offset {
  try {
    return parseOffset(localStorage.getItem(OFFSET_KEY));
  } catch {
    return NO_OFFSET;
  }
}

export function saveOffset(o: Offset): void {
  try {
    if (isNoOffset(o)) localStorage.removeItem(OFFSET_KEY);
    else localStorage.setItem(OFFSET_KEY, JSON.stringify(clampOffset(o)));
  } catch {
    /* 保存できなくても、この回は反映される */
  }
}
