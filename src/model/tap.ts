import type { OpenDirection } from './types';

/** 上部の帯(画面の上から、この割合まで)は、左右どこでもメニューの出し入れ。 */
export const TOP_BAND = 0.2;
/** 左右の端(ページ送り)の幅の割合 */
export const EDGE_WIDTH = 0.25;

/**
 * タップの領域(O-1)。
 * - band  : 上部の帯(上約20%・全幅)。メニューの出し入れ。左上・右上のタップが、ページ送りにならないように。
 * - next/prev : 帯の下の、左右の端25%ずつ。ページ送り。「次」の側は開き方向に連動(O-2)。
 * - center: 帯の下の中央50%。メニューの出し入れ(ダブルタップは拡大)。
 */
export type TapZone = 'band' | 'next' | 'prev' | 'center';

export function tapZone(
  xFraction: number,
  yFraction: number,
  direction: OpenDirection,
  edge = EDGE_WIDTH,
  band = TOP_BAND,
): TapZone {
  if (yFraction < band) return 'band';
  if (xFraction < edge) return direction === 'rtl' ? 'next' : 'prev';
  if (xFraction > 1 - edge) return direction === 'rtl' ? 'prev' : 'next';
  return 'center';
}

/** 矢印キーの割り当て。右開きは「←で次」が自然だが、仮置きの割り当て(要件8章)に従い、
 *  左右の矢印も開き方向に連動させる。Home/End は先頭/末尾。 */
export type KeyAction = 'next' | 'prev' | 'first' | 'last';

export function keyAction(key: string, direction: OpenDirection): KeyAction | null {
  switch (key) {
    case 'ArrowLeft':
      return direction === 'rtl' ? 'next' : 'prev';
    case 'ArrowRight':
      return direction === 'rtl' ? 'prev' : 'next';
    case 'ArrowDown':
    case 'PageDown':
      return 'next';
    case 'ArrowUp':
    case 'PageUp':
      return 'prev';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    default:
      return null;
  }
}
