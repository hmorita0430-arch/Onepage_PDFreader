import { describe, expect, it } from 'vitest';
import {
  addMemo, addRect, addStroke, annotationBounds, centerOf, deleteAnnotation, groupByPage, hitHighlight, numberMemos,
  pointToNorm, rectFrom, sideAt, updateMemoText, visibleAnnotations, STROKE_WIDTH,
} from '../src/model/annotations';
import { buildPageList } from '../src/model/pages';
import { mergeDocuments } from '../src/sync/merge';
import { DEFAULT_SETTINGS, newBookSyncDocument, type BookSettings } from '../src/model/types';
import { buildMarkdown } from '../src/export/markdown';

const s = (over: Partial<BookSettings> = {}): BookSettings => ({ ...DEFAULT_SETTINGS, pageOverrides: {}, ...over });
const R = { pdfPage: 2, side: 'R' as const };
const PAGE = { w: 2400, h: 1600 };

describe('注釈の操作(削除は墓標)', () => {
  it('追加・メモの編集・削除', () => {
    let l = addRect([], { page: R, color: 'yellow', rect: { x: 0.6, y: 0.2, w: 0.2, h: 0.05 } }, 100, 'a');
    l = addMemo(l, { page: R, at: { x: 0.7, y: 0.5 }, text: '重要' }, 110, 'm');
    l = updateMemoText(l, 'm', '重要(修正)', 120);
    expect(l.find((x) => x.id === 'm')).toMatchObject({ text: '重要(修正)', updatedAt: 120 });
    l = deleteAnnotation(l, 'a', 200);
    expect(l.find((x) => x.id === 'a')).toMatchObject({ deleted: true, updatedAt: 200 });
    expect(visibleAnnotations(l).map((x) => x.id)).toEqual(['m']);
  });
  it('同じ時刻でも更新日時は必ず進む(統合で負けない)', () => {
    const l = addMemo([], { page: R, at: { x: 0, y: 0 }, text: 'a' }, 100, 'm');
    expect(updateMemoText(l, 'm', 'b', 100)[0]!.updatedAt).toBeGreaterThan(100);
    expect(deleteAnnotation(l, 'm', 100)[0]!.updatedAt).toBeGreaterThan(100);
  });
  it('メモ以外の編集は無視する', () => {
    const l = addRect([], { page: R, color: 'pink', rect: { x: 0, y: 0, w: 0.1, h: 0.1 } }, 1, 'a');
    expect(updateMemoText(l, 'a', 'x', 5)).toEqual(l);
  });
});

describe('2台で別々に注釈を付けても、どちらも残る(同期)', () => {
  it('蛍光ペンとメモが両方残り、片方の削除が伝わる', () => {
    const base = addRect([], { page: R, color: 'blue', rect: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } }, 10, 'shared');
    const a = { ...newBookSyncDocument('b'), annotations: addMemo(base, { page: R, at: { x: 0.5, y: 0.5 }, text: 'A' }, 20, 'ma') };
    const b = { ...newBookSyncDocument('b'), annotations: deleteAnnotation(addStroke(base, { page: R, color: 'green', points: [{ x: 0.3, y: 0.3 }, { x: 0.4, y: 0.3 }] }, 30, 'sb'), 'shared', 40) };
    const m = mergeDocuments(a, b);
    expect(visibleAnnotations(m.annotations).map((x) => x.id).sort()).toEqual(['ma', 'sb']);
    expect(m.annotations.find((x) => x.id === 'shared')?.deleted).toBe(true);
  });
});

describe('座標', () => {
  const fit = { w: 400, h: 600 };
  const region = { x: 0.5, y: 0, w: 0.5, h: 1 }; // 右ページ
  it('フィット表示(ズームなし)の画面上の点を、元画像基準に直す', () => {
    const l = { tx: 0, ty: 100, scale: 1 };
    expect(pointToNorm(0, 100, l, fit, region)).toEqual({ x: 0.5, y: 0 });
    expect(pointToNorm(400, 700, l, fit, region)).toEqual({ x: 1, y: 1 });
    const mid = pointToNorm(200, 400, l, fit, region);
    expect(mid.x).toBeCloseTo(0.75);
    expect(mid.y).toBeCloseTo(0.5);
  });
  it('ズーム・移動していても、同じページ上の同じ点は同じ座標になる', () => {
    const fitL = { tx: 0, ty: 100, scale: 1 };
    const zoomed = { tx: -300, ty: -200, scale: 3 };
    // フィット表示で (100, 250) の点は、ズーム後は (100*3-300, (250-100)*3-200+... ) の位置にある
    const pxFit = (100 - fitL.tx) / fitL.scale, pyFit = (250 - fitL.ty) / fitL.scale;
    const sx = pxFit * zoomed.scale + zoomed.tx, sy = pyFit * zoomed.scale + zoomed.ty;
    const a = pointToNorm(100, 250, fitL, fit, region);
    const b = pointToNorm(sx, sy, zoomed, fit, region);
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.y).toBeCloseTo(a.y, 9);
  });
  it('トリミング(表示範囲が小さい)でも元画像基準の座標になる', () => {
    const cropped = { x: 0.6, y: 0.1, w: 0.3, h: 0.8 };
    const p = pointToNorm(0, 0, { tx: 0, ty: 0, scale: 1 }, fit, cropped);
    expect(p.x).toBeCloseTo(0.6);
    expect(p.y).toBeCloseTo(0.1);
  });
  it('表示範囲の外へはみ出さない', () => {
    const p = pointToNorm(-50, 9999, { tx: 0, ty: 0, scale: 1 }, fit, region);
    expect(p).toEqual({ x: 0.5, y: 1 });
  });
  it('どちら側か: 分割位置・ページ単位の分割位置・分割しないページ', () => {
    expect(sideAt(0.3, 1, s())).toBe('L');
    expect(sideAt(0.7, 1, s())).toBe('R');
    expect(sideAt(0.49, 1, s({ splitPosition: 0.48 }))).toBe('R');
    expect(sideAt(0.49, 3, s({ pageOverrides: { '3': { splitPosition: 0.52 } } }))).toBe('L');
    expect(sideAt(0.2, 4, s({ pageOverrides: { '4': { split: false } } }))).toBe('W');
  });
  it('矩形・中心', () => {
    const r = rectFrom({ x: 0.6, y: 0.5 }, { x: 0.4, y: 0.2 });
    expect(r).toEqual({ x: 0.4, y: 0.2, w: expect.closeTo(0.2, 9), h: expect.closeTo(0.3, 9) });
    expect(centerOf({ x: 0, y: 0, w: 1, h: 0.5 })).toEqual({ x: 0.5, y: 0.25 });
  });
});

describe('当たり判定(消しゴム)', () => {
  it('矩形: 内側は当たり、離れていれば外れる(余裕つき)', () => {
    const a = addRect([], { page: R, color: 'yellow', rect: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } }, 1, 'a')[0]!;
    expect(hitHighlight(a, { x: 0.55, y: 0.55 }, 0, PAGE)).toBe(true);
    expect(hitHighlight(a, { x: 0.8, y: 0.8 }, 10, PAGE)).toBe(false);
    expect(hitHighlight(a, { x: 0.499, y: 0.55 }, 10, PAGE)).toBe(true); // 2.4px の外側でも、余裕10pxで当たる
  });
  it('自由線: 線の太さの範囲で当たる', () => {
    const a = addStroke([], { page: R, color: 'pink', points: [{ x: 0.2, y: 0.5 }, { x: 0.6, y: 0.5 }] }, 1, 's')[0]!;
    expect(hitHighlight(a, { x: 0.4, y: 0.5 }, 0, PAGE)).toBe(true);
    expect(hitHighlight(a, { x: 0.4, y: 0.5 + (STROKE_WIDTH * PAGE.w / 2 - 1) / PAGE.h }, 0, PAGE)).toBe(true);
    expect(hitHighlight(a, { x: 0.4, y: 0.7 }, 5, PAGE)).toBe(false);
    expect(hitHighlight(a, { x: 0.9, y: 0.5 }, 5, PAGE)).toBe(false);
  });
  it('自由線の囲み: 線の太さの分だけ広い。縦は縦横比を考慮', () => {
    const a = addStroke([], { page: R, color: 'pink', points: [{ x: 0.2, y: 0.5 }, { x: 0.6, y: 0.5 }] }, 1, 's')[0]!;
    const b = annotationBounds(a, PAGE);
    expect(b.x).toBeCloseTo(0.2 - STROKE_WIDTH / 2, 9);
    expect(b.h).toBeCloseTo(STROKE_WIDTH * (PAGE.w / PAGE.h), 9);
  });
});

describe('ページごとの整理とメモ番号', () => {
  const pages = buildPageList(3, s()); // 1R 1L 2R 2L 3R 3L
  it('論理ページ(読む順)ごとにまとめ、作成順に並べる。削除済みは除く', () => {
    let l = addMemo([], { page: { pdfPage: 2, side: 'L' }, at: { x: 0.2, y: 0.2 }, text: 'b' }, 20, 'b');
    l = addMemo(l, { page: { pdfPage: 2, side: 'L' }, at: { x: 0.3, y: 0.3 }, text: 'a' }, 10, 'a');
    l = addRect(l, { page: { pdfPage: 1, side: 'R' }, color: 'yellow', rect: { x: 0.6, y: 0.1, w: 0.1, h: 0.1 } }, 5, 'r');
    l = deleteAnnotation(l, 'r', 50);
    const g = groupByPage(pages, l);
    expect([...g.keys()]).toEqual([3]); // 2L は論理ページ 3
    expect(g.get(3)!.map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('設定変更で無くなった面の注釈は、同じ見開きの先頭ページに寄せる', () => {
    const cover = buildPageList(2, s({ firstPage: 'R' })); // 1R 2R 2L
    const l = addMemo([], { page: { pdfPage: 1, side: 'L' }, at: { x: 0.2, y: 0.2 }, text: 'x' }, 1, 'x');
    expect([...groupByPage(cover, l).keys()]).toEqual([0]);
  });
  it('メモ番号は作成順に 1, 2, …(蛍光ペンは数えない)', () => {
    let l = addMemo([], { page: R, at: { x: 0, y: 0 }, text: '' }, 1, 'm1');
    l = addRect(l, { page: R, color: 'blue', rect: { x: 0, y: 0, w: 0.1, h: 0.1 } }, 2, 'r');
    l = addMemo(l, { page: R, at: { x: 0, y: 0 }, text: '' }, 3, 'm2');
    expect([...numberMemos(l).entries()]).toEqual([['m1', 1], ['m2', 2]]);
  });
});

describe('Markdown(読書ノート)', () => {
  const at = new Date(2026, 10, 13, 9, 5);
  it('ページごとに、画像・メモ・蛍光ペン(OCRの文字つき)を並べる', () => {
    const md = buildMarkdown({
      title: 'テスト本.pdf'.replace('.pdf', ''), exportedAt: at,
      pages: [{
        label: 'p.45(通し番号52)', imagePath: 'images/page-052.jpg',
        items: [
          { kind: 'memo', n: 1, text: '重要\n2行目' },
          { kind: 'highlight', colorLabel: '黄', ocr: '戦略とは  捨てること' },
          { kind: 'highlight', colorLabel: '青', ocr: null },
        ],
      }],
    });
    expect(md).toContain('# テスト本 読書ノート');
    expect(md).toContain('- 出力日時: 2026-11-13 09:05');
    expect(md).toContain('- メモ 1件 / 蛍光ペン 2件');
    expect(md).toContain('## p.45(通し番号52)');
    expect(md).toContain('![p.45(通し番号52)](images/page-052.jpg)');
    expect(md).toContain('- **メモ1**: 重要\n  2行目');
    expect(md).toContain('- **蛍光ペン(黄)**: 「戦略とは 捨てること」');
    expect(md).toContain('- **蛍光ペン(青)**: (文字データなし)');
    expect(md).toContain('誤認識を含む場合があります');
  });
  it('OCRを添えない(undefined)ときは、文字の欄も注記も出さない', () => {
    const md = buildMarkdown({ title: 'x', exportedAt: at, pages: [{ label: 'p.1', imagePath: null, items: [{ kind: 'highlight', colorLabel: '緑' }] }] });
    expect(md).toContain('- **蛍光ペン(緑)**');
    expect(md).not.toContain('文字データなし');
    expect(md).not.toContain('誤認識');
    expect(md).not.toContain('![');
  });
});
