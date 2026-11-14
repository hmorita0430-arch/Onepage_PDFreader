import type { ReadingDate, ReadingRecord } from './types';
import { stableStringify } from '../sync/stable';

/**
 * 読書の記録(読み始めた日・読了日)。DOM・通信に依存しない純粋関数。
 *
 * - 読み始めた日: 初めて開いた日を自動で入れる(auto)。手で直した値(manual)があれば、そちらが優先。
 *   別々の端末で初めて開いた場合は、早い方の日付を採る(どの端末で先に開いても、同じ結果になる)。
 * - 読了日: 最終ページで「読了にしますか?」に「はい」と答えたとき、または手で入れたときだけ記録する。
 *   日時が新しい操作が優先(消した場合は date が null)。
 * 日付は端末の暮らしている日付(YYYY-MM-DD)。時刻は持たない。
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** 端末の暦の日付(YYYY-MM-DD) */
export function localDateString(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isValidDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const t = new Date(y, m - 1, d);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
}

function dayNumber(s: string): number {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** 読んだ期間(日数)。読み始めた日と読了日の両方があるときだけ。当日に読み終えたら1日間(両端を含む) */
export function readingDays(r: ReadingRecord | undefined): number | null {
  const s = r?.startedAt?.date;
  const f = r?.finishedAt?.date;
  if (!s || !f || f < s) return null;
  return dayNumber(f) - dayNumber(s) + 1;
}

/** 画面用の1行。例: 「2026/11/01 〜 2026/11/14(14日間)」「読み始め 2026/11/01」 */
export function readingSummary(r: ReadingRecord | undefined): string {
  const s = r?.startedAt?.date ?? null;
  const f = r?.finishedAt?.date ?? null;
  const fmt = (d: string) => d.replace(/-/g, '/');
  if (s && f) {
    const n = readingDays(r);
    return `${fmt(s)} 〜 ${fmt(f)}${n ? `(${n}日間)` : ''}`;
  }
  if (f) return `読了 ${fmt(f)}`;
  if (s) return `読み始め ${fmt(s)}`;
  return '';
}

/** 初めて開いたとき、読み始めた日を入れる。すでに(手で消した場合も)記録があれば、何もしない。変更したら true */
export function stampStarted(r: ReadingRecord, now: number): boolean {
  if (r.startedAt) return false;
  r.startedAt = { date: localDateString(now), updatedAt: now, manual: false };
  return true;
}

export function setStarted(r: ReadingRecord, date: string | null, now: number): void {
  r.startedAt = { date, updatedAt: now, manual: true };
}

export function setFinished(r: ReadingRecord, date: string | null, now: number): void {
  r.finishedAt = { date, updatedAt: now, manual: true };
}

/** 読了したか */
export function isFinished(r: ReadingRecord | undefined): boolean {
  return Boolean(r?.finishedAt?.date);
}

/** ドライブから読み込んだ値を検査して、正しい形のものだけを残す(壊れた・不正な値は捨てる) */
export function sanitizeReading(raw: unknown): ReadingRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const one = (v: unknown): ReadingDate | undefined => {
    if (!v || typeof v !== 'object') return undefined;
    const o = v as Partial<ReadingDate>;
    if (typeof o.updatedAt !== 'number' || !Number.isFinite(o.updatedAt)) return undefined;
    if (o.date !== null && !isValidDate(o.date)) return undefined;
    return { date: o.date, updatedAt: o.updatedAt, manual: o.manual === true };
  };
  const r = raw as Partial<Record<keyof ReadingRecord, unknown>>;
  const out: ReadingRecord = {};
  const s = one(r.startedAt);
  const f = one(r.finishedAt);
  if (s) out.startedAt = s;
  if (f) out.finishedAt = f;
  return s || f ? out : undefined;
}

// ---------- 同期の統合 ----------

function newerOf(a: ReadingDate, b: ReadingDate): ReadingDate {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return stableStringify(a) >= stableStringify(b) ? a : b;
}

/** 読み始めた日: 手で入れた値が優先(複数なら新しい方)。自動どうしは、早い日付 */
function pickStarted(a: ReadingDate, b: ReadingDate): ReadingDate {
  if (a.manual !== b.manual) return a.manual ? a : b;
  if (a.manual) return newerOf(a, b);
  const da = a.date ?? '';
  const db = b.date ?? '';
  if (da !== db) return da < db ? a : b;
  return newerOf(a, b);
}

function pickWith(
  a: ReadingDate | undefined,
  b: ReadingDate | undefined,
  pick: (x: ReadingDate, y: ReadingDate) => ReadingDate,
): ReadingDate | undefined {
  if (!a) return b;
  if (!b) return a;
  return pick(a, b);
}

/** どの順序で統合しても同じ結果になる(可換・冪等・結合的) */
export function mergeReading(a: ReadingRecord | undefined, b: ReadingRecord | undefined): ReadingRecord {
  const out: ReadingRecord = {};
  const s = pickWith(a?.startedAt, b?.startedAt, pickStarted);
  const f = pickWith(a?.finishedAt, b?.finishedAt, newerOf);
  if (s) out.startedAt = s;
  if (f) out.finishedAt = f;
  return out;
}

/** 前回の同期(base)から変わっている項目の数(未同期の件数・同期するかの判断用) */
export function readingChanges(local: ReadingRecord | undefined, base: ReadingRecord | undefined): number {
  let n = 0;
  if (local?.startedAt && local.startedAt.updatedAt !== base?.startedAt?.updatedAt) n++;
  if (local?.finishedAt && local.finishedAt.updatedAt !== base?.finishedAt?.updatedAt) n++;
  return n;
}
