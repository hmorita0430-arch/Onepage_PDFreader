import type { OpenDirection } from './types';

export type TapAction = 'next' | 'prev' | 'menu';

/** 画面の左右の端をタップでページ送り、中央でメニュー(O-1)。「次」の側は開き方向に連動(O-2)。 */
export function tapAction(xFraction: number, direction: OpenDirection, edge = 0.25): TapAction {
  if (xFraction < edge) return direction === 'rtl' ? 'next' : 'prev';
  if (xFraction > 1 - edge) return direction === 'rtl' ? 'prev' : 'next';
  return 'menu';
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
