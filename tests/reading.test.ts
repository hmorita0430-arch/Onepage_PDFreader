import { describe, expect, it } from 'vitest';
import {
  isFinished,
  sanitizeReading,
  isValidDate,
  localDateString,
  mergeReading,
  readingChanges,
  readingDays,
  readingSummary,
  setFinished,
  setStarted,
  stampStarted,
} from '../src/model/reading';
import { mergeDocuments } from '../src/sync/merge';
import { newBookSyncDocument, type ReadingRecord } from '../src/model/types';
import { isLastPage } from '../src/model/layout';
import { buildPageList } from '../src/model/pages';
import { DEFAULT_SETTINGS } from '../src/model/types';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

describe('読書の記録: 日付', () => {
  it('端末の暦の日付を作る', () => {
    expect(localDateString(at(2026, 11, 14, 23))).toBe('2026-11-14');
    expect(localDateString(at(2026, 1, 5, 0))).toBe('2026-01-05');
  });
  it('日付の形式を確かめる', () => {
    expect(isValidDate('2026-11-14')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2026/11/14')).toBe(false);
    expect(isValidDate('')).toBe(false);
    expect(isValidDate(null)).toBe(false);
  });
  it('読んだ期間は、両端を含む日数(当日に読み終えたら1日間)', () => {
    const r: ReadingRecord = {};
    setStarted(r, '2026-11-01', 1);
    setFinished(r, '2026-11-01', 2);
    expect(readingDays(r)).toBe(1);
    setFinished(r, '2026-11-14', 3);
    expect(readingDays(r)).toBe(14);
    setFinished(r, '2026-12-01', 4);
    expect(readingDays(r)).toBe(31);
  });
  it('月またぎ・年またぎの日数', () => {
    const r: ReadingRecord = {};
    setStarted(r, '2025-12-30', 1);
    setFinished(r, '2026-01-02', 2);
    expect(readingDays(r)).toBe(4);
  });
  it('読了日が読み始めより前、または片方がないときは、期間なし', () => {
    const r: ReadingRecord = {};
    expect(readingDays(r)).toBeNull();
    setStarted(r, '2026-11-10', 1);
    expect(readingDays(r)).toBeNull();
    setFinished(r, '2026-11-01', 2);
    expect(readingDays(r)).toBeNull();
    expect(readingDays(undefined)).toBeNull();
  });
  it('画面用の1行', () => {
    const r: ReadingRecord = {};
    expect(readingSummary(r)).toBe('');
    setStarted(r, '2026-11-01', 1);
    expect(readingSummary(r)).toBe('読み始め 2026/11/01');
    setFinished(r, '2026-11-14', 2);
    expect(readingSummary(r)).toBe('2026/11/01 〜 2026/11/14(14日間)');
    setStarted(r, null, 3);
    expect(readingSummary(r)).toBe('読了 2026/11/14');
  });
});

describe('読書の記録: 初めて開いた日・読了', () => {
  it('初めて開いたときだけ、読み始めた日を入れる', () => {
    const r: ReadingRecord = {};
    expect(stampStarted(r, at(2026, 11, 1))).toBe(true);
    expect(r.startedAt).toMatchObject({ date: '2026-11-01', manual: false });
    expect(stampStarted(r, at(2026, 11, 9))).toBe(false);
    expect(r.startedAt?.date).toBe('2026-11-01');
  });
  it('手で消した読み始めは、次に開いても自動では入らない', () => {
    const r: ReadingRecord = {};
    stampStarted(r, at(2026, 11, 1));
    setStarted(r, null, at(2026, 11, 2));
    expect(stampStarted(r, at(2026, 11, 3))).toBe(false);
    expect(r.startedAt?.date).toBeNull();
  });
  it('読了の有無', () => {
    const r: ReadingRecord = {};
    expect(isFinished(r)).toBe(false);
    setFinished(r, '2026-11-14', 1);
    expect(isFinished(r)).toBe(true);
    setFinished(r, null, 2);
    expect(isFinished(r)).toBe(false);
    expect(isFinished(undefined)).toBe(false);
  });
});

describe('読書の記録: 同期の統合', () => {
  const rec = (s?: [string, number, boolean], f?: [string | null, number]): ReadingRecord => {
    const r: ReadingRecord = {};
    if (s) r.startedAt = { date: s[0], updatedAt: s[1], manual: s[2] };
    if (f) r.finishedAt = { date: f[0], updatedAt: f[1], manual: true };
    return r;
  };
  it('別々の端末で初めて開いた: 早い日付を採る(順序に依らない)', () => {
    const a = rec(['2026-11-05', 500, false]);
    const b = rec(['2026-11-03', 900, false]);
    expect(mergeReading(a, b).startedAt?.date).toBe('2026-11-03');
    expect(mergeReading(b, a).startedAt?.date).toBe('2026-11-03');
  });
  it('手で直した読み始めは、自動より優先(日付が遅くても)', () => {
    const a = rec(['2026-11-01', 100, false]);
    const b = rec(['2026-11-10', 200, true]);
    expect(mergeReading(a, b).startedAt).toMatchObject({ date: '2026-11-10', manual: true });
    expect(mergeReading(b, a).startedAt).toMatchObject({ date: '2026-11-10', manual: true });
  });
  it('手で直した値どうしは、新しい方', () => {
    const a = rec(['2026-11-01', 100, true]);
    const b = rec(['2026-11-02', 200, true]);
    expect(mergeReading(a, b).startedAt?.date).toBe('2026-11-02');
  });
  it('読了日は、新しい操作が優先。消した操作も伝わる', () => {
    const a = rec(undefined, ['2026-11-14', 100]);
    const b = rec(undefined, [null, 200]);
    expect(mergeReading(a, b).finishedAt?.date).toBeNull();
    expect(mergeReading(b, a).finishedAt?.date).toBeNull();
    const c = rec(undefined, ['2026-11-20', 300]);
    expect(mergeReading(b, c).finishedAt?.date).toBe('2026-11-20');
  });
  it('片方にしかない項目は、そのまま残る。両方空なら空', () => {
    const a = rec(['2026-11-01', 1, false]);
    const b = rec(undefined, ['2026-11-14', 2]);
    const m = mergeReading(a, b);
    expect(m.startedAt?.date).toBe('2026-11-01');
    expect(m.finishedAt?.date).toBe('2026-11-14');
    expect(mergeReading(undefined, undefined)).toEqual({});
  });
  it('可換・冪等・結合的', () => {
    const xs = [
      rec(['2026-11-05', 5, false], ['2026-11-14', 50]),
      rec(['2026-11-03', 9, false], [null, 60]),
      rec(['2026-11-09', 7, true]),
      rec(['2026-11-02', 8, true], ['2026-11-30', 40]),
      rec(),
    ];
    const eq = (p: ReadingRecord, q: ReadingRecord) => expect(JSON.stringify(p)).toBe(JSON.stringify(q));
    for (const a of xs) {
      eq(mergeReading(a, a), mergeReading(a, undefined));
      for (const b of xs) {
        eq(mergeReading(a, b), mergeReading(b, a));
        for (const c of xs) eq(mergeReading(mergeReading(a, b), c), mergeReading(a, mergeReading(b, c)));
      }
    }
  });
  it('文書の統合に反映される。記録がなければ、項目ごと省く', () => {
    const a = newBookSyncDocument('b');
    const b = newBookSyncDocument('b');
    expect('reading' in mergeDocuments(a, b)).toBe(false);
    b.reading = rec(['2026-11-03', 9, false]);
    expect(mergeDocuments(a, b).reading?.startedAt?.date).toBe('2026-11-03');
    expect(mergeDocuments(b, a).reading?.startedAt?.date).toBe('2026-11-03');
  });
  it('未同期の件数: 前回から変わった項目だけ', () => {
    const base = rec(['2026-11-01', 1, false]);
    const local = rec(['2026-11-01', 1, false]);
    expect(readingChanges(local, base)).toBe(0);
    setFinished(local, '2026-11-14', 5);
    expect(readingChanges(local, base)).toBe(1);
    setStarted(local, '2026-11-02', 6);
    expect(readingChanges(local, base)).toBe(2);
    expect(readingChanges(local, undefined)).toBe(2);
    expect(readingChanges(undefined, base)).toBe(0);
  });
});

describe('最後のページの判定', () => {
  const list = buildPageList(3, { ...DEFAULT_SETTINGS, firstPage: 'both' });
  it('1ページ表示: 最後の1ページだけ', () => {
    expect(isLastPage(list, list.length - 2, false)).toBe(false);
    expect(isLastPage(list, list.length - 1, false)).toBe(true);
  });
  it('2ページ表示: 最後の見開き(どちらの側でも)', () => {
    expect(isLastPage(list, list.length - 1, true)).toBe(true);
    expect(isLastPage(list, list.length - 2, true)).toBe(true);
    expect(isLastPage(list, 0, true)).toBe(false);
  });
  it('ページがなければ false', () => {
    expect(isLastPage([], 0, false)).toBe(false);
  });
});

describe('ドライブから読み込んだ記録の検査', () => {
  it('正しい記録は、そのまま通る', () => {
    const r = sanitizeReading({ startedAt: { date: '2026-11-01', updatedAt: 5, manual: false }, finishedAt: { date: null, updatedAt: 9, manual: true } });
    expect(r).toEqual({ startedAt: { date: '2026-11-01', updatedAt: 5, manual: false }, finishedAt: { date: null, updatedAt: 9, manual: true } });
  });
  it('壊れた・不正な値は捨てる(他の項目は残す)', () => {
    expect(sanitizeReading(null)).toBeUndefined();
    expect(sanitizeReading('x')).toBeUndefined();
    expect(sanitizeReading({})).toBeUndefined();
    expect(sanitizeReading({ startedAt: { date: '2026-13-40', updatedAt: 1 } })).toBeUndefined();
    expect(sanitizeReading({ startedAt: { date: '2026-11-01' } })).toBeUndefined();
    const r = sanitizeReading({ startedAt: { date: 'bad', updatedAt: 1 }, finishedAt: { date: '2026-11-14', updatedAt: 2, manual: 1 } });
    expect(r).toEqual({ finishedAt: { date: '2026-11-14', updatedAt: 2, manual: false } });
  });
});
