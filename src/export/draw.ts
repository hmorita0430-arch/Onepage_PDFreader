import { COLORS, numberMemos, type PageSize } from '../model/annotations';
import type { Annotation, NormRect } from '../model/types';

/** 蛍光ペンの濃さ。紙の文字が透けるよう、乗算で重ねる */
export const HIGHLIGHT_ALPHA = 0.45;

/**
 * 書き出し画像に、注釈を描き込む。canvas は region(元画像基準の表示範囲)を描いたもの、
 * page は元のPDFページの大きさ(線の太さを、画像の幅に対する割合から求めるため)。
 */
export function drawAnnotations(canvas: HTMLCanvasElement, annos: readonly Annotation[], region: NormRect, _page: PageSize): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  const px = (nx: number) => ((nx - region.x) / region.w) * W;
  const py = (ny: number) => ((ny - region.y) / region.h) * H;

  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = HIGHLIGHT_ALPHA;
  for (const a of annos) {
    if (a.kind === 'highlight-rect') {
      ctx.fillStyle = COLORS[a.color].css;
      ctx.fillRect(px(a.rect.x), py(a.rect.y), (a.rect.w / region.w) * W, (a.rect.h / region.h) * H);
    } else if (a.kind === 'highlight-stroke' && a.points.length > 0) {
      ctx.strokeStyle = COLORS[a.color].css;
      ctx.lineWidth = (a.width / region.w) * W; // 画像の幅に対する割合 → 画素
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      a.points.forEach((p, i) => (i === 0 ? ctx.moveTo(px(p.x), py(p.y)) : ctx.lineTo(px(p.x), py(p.y))));
      if (a.points.length === 1) ctx.lineTo(px(a.points[0]!.x) + 0.01, py(a.points[0]!.y)); // 点だけでも丸を描く
      ctx.stroke();
    }
  }
  ctx.restore();

  // メモ: 番号つきの丸(Markdownの「メモN」と対応)
  const nums = numberMemos(annos);
  const r = Math.max(14, W * 0.018);
  ctx.save();
  ctx.font = `bold ${Math.round(r * 1.2)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const a of annos) {
    if (a.kind !== 'memo') continue;
    const x = px(a.at.x);
    const y = py(a.at.y);
    ctx.fillStyle = '#e8590c';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(2, r * 0.18);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(nums.get(a.id) ?? ''), x, y + r * 0.05);
  }
  ctx.restore();
}
