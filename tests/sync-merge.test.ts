import { describe, expect, it } from 'vitest';
import { countUnsynced, mergeDocuments, mergeItems, stableStringify } from '../src/sync/merge';
import { addNamedPage, deleteNamedPage, renameNamedPage, visibleNamed } from '../src/model/named';
import { jumpTarget, buildPageList } from '../src/model/pages';
import { DEFAULT_SETTINGS, newBookSyncDocument, type BookSyncDocument, type HighlightRect, type NamedPage } from '../src/model/types';

const doc = (over: Partial<BookSyncDocument> = {}): BookSyncDocument => ({ ...newBookSyncDocument('book1'), ...over });
const np = (id: string, title: string, t: number, extra: Partial<NamedPage> = {}): NamedPage => ({
  id, kind: 'bookmark', title, page: { pdfPage: 3, side: 'R' }, createdAt: t, updatedAt: t, ...extra,
});
const hl = (id: string, t: number, extra: Partial<HighlightRect> = {}): HighlightRect => ({
  id, kind: 'highlight-rect', color: 'yellow', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 },
  page: { pdfPage: 2, side: 'L' }, createdAt: t, updatedAt: t, ...extra,
});

describe('統合: 両端末の追加は両方残る(消えない)', () => {
  it('オフラインで別々にしおり・注釈を追加しても、どちらも消えない', () => {
    const a = doc({ namedPages: [np('a1', 'Aのしおり', 100)], annotations: [hl('h1', 110)] });
    const b = doc({ namedPages: [np('b1', 'Bのしおり', 105)], annotations: [hl('h2', 120)] });
    const m = mergeDocuments(a, b);
    expect(m.namedPages.map((x) => x.id)).toEqual(['a1', 'b1']);
    expect(m.annotations.map((x) => x.id)).toEqual(['h1', 'h2']);
  });

  it('同じ1件を両方で編集したら、新しい方を採用する', () => {
    const a = doc({ namedPages: [np('x', '古い題', 100, { updatedAt: 200 })] });
    const b = doc({ namedPages: [np('x', '新しい題', 100, { updatedAt: 300 })] });
    expect(mergeDocuments(a, b).namedPages[0]?.title).toBe('新しい題');
    expect(mergeDocuments(b, a).namedPages[0]?.title).toBe('新しい題');
  });

  it('削除は墓標として伝わり、削除より後の編集がなければ復活しない', () => {
    const base = np('x', '題', 100);
    const a = doc({ namedPages: deleteNamedPage([base], 'x', 500) });
    const b = doc({ namedPages: [base] }); // 他端末はまだ知らない
    const m = mergeDocuments(a, b);
    expect(m.namedPages).toHaveLength(1);
    expect(m.namedPages[0]?.deleted).toBe(true);
    expect(visibleNamed(m.namedPages, 'bookmark')).toHaveLength(0);
  });

  it('削除より後に他端末で編集していれば、編集が残る(新しい方)', () => {
    const base = np('x', '題', 100);
    const a = doc({ namedPages: deleteNamedPage([base], 'x', 500) });
    const b = doc({ namedPages: renameNamedPage([base], 'x', '直した', 900) });
    expect(mergeDocuments(a, b).namedPages[0]?.title).toBe('直した');
    expect(mergeDocuments(a, b).namedPages[0]?.deleted).toBeUndefined();
  });
});

describe('統合: 位置と設定', () => {
  it('最後に読んだ位置は日時が新しい方', () => {
    const a = doc({ position: { page: { pdfPage: 5, side: 'R' }, updatedAt: 100 } });
    const b = doc({ position: { page: { pdfPage: 9, side: 'L' }, updatedAt: 200 } });
    expect(mergeDocuments(a, b).position?.page.pdfPage).toBe(9);
    expect(mergeDocuments(doc(), b).position?.page.pdfPage).toBe(9);
    expect(mergeDocuments(a, doc()).position?.page.pdfPage).toBe(5);
  });

  it('本ごとの設定は項目ごとに新しい方(別々の項目は両方反映)', () => {
    const a = doc({
      settings: { ...DEFAULT_SETTINGS, splitPosition: 0.48, openDirection: 'ltr' },
      settingsUpdatedAt: { splitPosition: 300, openDirection: 100 },
    });
    const b = doc({
      settings: { ...DEFAULT_SETTINGS, splitPosition: 0.52, firstPage: 'R' },
      settingsUpdatedAt: { splitPosition: 200, firstPage: 400 },
    });
    const m = mergeDocuments(a, b);
    expect(m.settings.splitPosition).toBe(0.48); // 300 > 200
    expect(m.settings.openDirection).toBe('ltr'); // aだけが変更
    expect(m.settings.firstPage).toBe('R'); // bだけが変更
    expect(m.settingsUpdatedAt).toEqual({ splitPosition: 300, openDirection: 100, firstPage: 400 });
  });

  it('別の本は統合しない', () => {
    expect(() => mergeDocuments(doc(), { ...doc(), bookId: 'other' })).toThrow();
  });
});

describe('統合の性質(順序に依存しない)', () => {
  const a = doc({
    namedPages: [np('1', 'a', 10), np('2', 'same', 20, { updatedAt: 50 })],
    annotations: [hl('h1', 5)],
    settings: { ...DEFAULT_SETTINGS, splitPosition: 0.4 }, settingsUpdatedAt: { splitPosition: 70 },
    position: { page: { pdfPage: 2, side: 'R' }, updatedAt: 70 },
  });
  const b = doc({
    namedPages: [np('2', 'same?', 20, { updatedAt: 50 }), np('3', 'b', 30)], // id 2 は同時刻で内容が違う
    settings: { ...DEFAULT_SETTINGS, splitPosition: 0.6 }, settingsUpdatedAt: { splitPosition: 70 }, // 同時刻
    position: { page: { pdfPage: 8, side: 'L' }, updatedAt: 70 },
  });
  const c = doc({ namedPages: [np('4', 'c', 40)], annotations: [hl('h2', 6)] });

  it('可換: merge(a,b) = merge(b,a)(同時刻でも)', () => {
    expect(stableStringify(mergeDocuments(a, b))).toBe(stableStringify(mergeDocuments(b, a)));
  });
  it('冪等: merge(a,a) = a', () => {
    expect(stableStringify(mergeDocuments(a, a))).toBe(stableStringify(mergeDocuments(a, a)));
    const m = mergeDocuments(a, b);
    expect(stableStringify(mergeDocuments(m, m))).toBe(stableStringify(m));
    expect(stableStringify(mergeDocuments(m, a))).toBe(stableStringify(m));
  });
  it('結合的: (a+b)+c = a+(b+c)', () => {
    expect(stableStringify(mergeDocuments(mergeDocuments(a, b), c))).toBe(
      stableStringify(mergeDocuments(a, mergeDocuments(b, c))),
    );
  });
  it('mergeItems は作成日時順で安定', () => {
    expect(mergeItems([np('z', 'z', 1)], [np('a', 'a', 1)]).map((x) => x.id)).toEqual(['a', 'z']);
  });
});

describe('未同期の件数(G-3)', () => {
  it('同期直後は0。手元で増やした分だけ数える', () => {
    const base = doc({ namedPages: [np('1', 'a', 10)], settings: { ...DEFAULT_SETTINGS }, settingsUpdatedAt: { splitPosition: 5 } });
    expect(countUnsynced(base, base)).toBe(0);
    const local = doc({
      ...base,
      namedPages: [np('1', 'a', 10), np('2', 'new', 20)],
      settingsUpdatedAt: { splitPosition: 5, openDirection: 30 },
      position: { page: { pdfPage: 1, side: 'R' }, updatedAt: 40 },
    });
    expect(countUnsynced(local, base)).toBe(3); // しおり1件 + 設定1項目 + 位置
  });
  it('編集・削除も1件として数える', () => {
    const base = doc({ namedPages: [np('1', 'a', 10)] });
    expect(countUnsynced(doc({ namedPages: renameNamedPage(base.namedPages, '1', 'b', 50) }), base)).toBe(1);
    expect(countUnsynced(doc({ namedPages: deleteNamedPage(base.namedPages, '1', 50) }), base)).toBe(1);
  });
  it('基準が無いときは、手元の全項目が未同期', () => {
    expect(countUnsynced(doc({ namedPages: [np('1', 'a', 1), np('2', 'b', 2)] }), null)).toBe(2);
  });
});

describe('名前つきページの操作', () => {
  it('追加・改名・削除(墓標)', () => {
    let list = addNamedPage([], { kind: 'toc', title: '第3章', page: { pdfPage: 45, side: 'R' } }, 100, 'id1');
    list = renameNamedPage(list, 'id1', '第3章 戦略', 200);
    expect(list[0]?.title).toBe('第3章 戦略');
    list = deleteNamedPage(list, 'id1', 300);
    expect(list[0]?.deleted).toBe(true);
    expect(visibleNamed(list, 'toc')).toEqual([]);
  });
  it('同じ時刻に編集しても更新日時は必ず進む(統合で負けない)', () => {
    const list = addNamedPage([], { kind: 'bookmark', title: 'a', page: { pdfPage: 1, side: 'R' } }, 100, 'id1');
    expect(renameNamedPage(list, 'id1', 'b', 100)[0]!.updatedAt).toBeGreaterThan(100);
  });
});

describe('ページジャンプ(N-2)', () => {
  const settings = { ...DEFAULT_SETTINGS, printedNumber: { serial: 8, printed: 1 } };
  const list = buildPageList(10, settings); // 20ページ
  it('通し番号', () => {
    expect(jumpTarget(list, settings, 'serial', 1)).toBe(0);
    expect(jumpTarget(list, settings, 'serial', 20)).toBe(19);
    expect(jumpTarget(list, settings, 'serial', 21)).toBeNull();
    expect(jumpTarget(list, settings, 'serial', 0)).toBeNull();
  });
  it('印刷番号(通し番号8=p.1)', () => {
    expect(jumpTarget(list, settings, 'printed', 1)).toBe(7);
    expect(jumpTarget(list, settings, 'printed', 13)).toBe(19);
    expect(jumpTarget(list, settings, 'printed', 14)).toBeNull();
    expect(jumpTarget(list, { ...settings, printedNumber: null }, 'printed', 1)).toBeNull();
  });
  it('整数以外は無効', () => {
    expect(jumpTarget(list, settings, 'serial', 1.5)).toBeNull();
    expect(jumpTarget(list, settings, 'serial', NaN)).toBeNull();
  });
});
