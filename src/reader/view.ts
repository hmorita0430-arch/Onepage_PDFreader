/**
 * ズームと表示位置の計算(D-8, D-9)。DOM に依存しない純粋関数。
 *
 * 状態は「倍率 z(フィット表示=1)」と「ビューポート中央に来るページ内の相対位置 (cx, cy)」。
 * 相対位置はトリミング後のページ内の 0〜1 なので、ページが変わっても(ズーム維持モードで)
 * 同じ相対位置を引き継げる(要件 D-9)。
 */
export interface Size {
  w: number;
  h: number;
}

export interface ViewState {
  z: number;
  cx: number;
  cy: number;
}

export const MIN_Z = 1;
export const MAX_Z = 6;
export const DOUBLE_TAP_Z = 2.5;
export const RESET_VIEW: ViewState = { z: 1, cx: 0.5, cy: 0.5 };

const EPS = 0.5;

export function fitSize(box: Size, content: Size): Size {
  const s = Math.min(box.w / content.w, box.h / content.h);
  return { w: content.w * s, h: content.h * s };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function axis(boxLen: number, fitLen: number, z: number, c: number): number {
  const len = fitLen * z;
  if (len <= boxLen + EPS) return (boxLen - len) / 2;
  return clamp(boxLen / 2 - c * len, boxLen - len, 0);
}

export interface Layout {
  tx: number;
  ty: number;
  scale: number;
}

export function layout(box: Size, fit: Size, st: ViewState): Layout {
  return { tx: axis(box.w, fit.w, st.z, st.cx), ty: axis(box.h, fit.h, st.z, st.cy), scale: st.z };
}

/** 範囲外にはみ出さないように補正した状態を返す */
export function clampState(box: Size, fit: Size, st: ViewState): ViewState {
  const z = clamp(st.z, MIN_Z, MAX_Z);
  const l = layout(box, fit, { ...st, z });
  const cx = fit.w * z <= box.w + EPS ? 0.5 : (box.w / 2 - l.tx) / (fit.w * z);
  const cy = fit.h * z <= box.h + EPS ? 0.5 : (box.h / 2 - l.ty) / (fit.h * z);
  return { z, cx, cy };
}

/** 画面上の点 (px, py) を動かさずに、倍率を newZ にする */
export function zoomAt(box: Size, fit: Size, st: ViewState, newZ: number, px: number, py: number): ViewState {
  const z2 = clamp(newZ, MIN_Z, MAX_Z);
  const cur = layout(box, fit, st);
  const nx = (px - cur.tx) / (fit.w * st.z);
  const ny = (py - cur.ty) / (fit.h * st.z);
  const tx = px - nx * fit.w * z2;
  const ty = py - ny * fit.h * z2;
  return clampState(box, fit, {
    z: z2,
    cx: (box.w / 2 - tx) / (fit.w * z2),
    cy: (box.h / 2 - ty) / (fit.h * z2),
  });
}

/** 指(カーソル)の移動量 (dx, dy) だけ、ページを追従させて動かす */
export function panBy(box: Size, fit: Size, st: ViewState, dx: number, dy: number): ViewState {
  return clampState(box, fit, {
    z: st.z,
    cx: st.cx - dx / (fit.w * st.z),
    cy: st.cy - dy / (fit.h * st.z),
  });
}

export const isZoomed = (st: ViewState): boolean => st.z > 1.02;
