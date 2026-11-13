import type { NamedPage, PageRef } from './types';

/** 名前つきページ(しおり・目次)の操作。削除は消さずに「削除済み」の印(墓標)を残す(同期で他端末に伝えるため)。 */

export function newId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function addNamedPage(
  list: readonly NamedPage[],
  p: { kind: NamedPage['kind']; title: string; page: PageRef },
  now = Date.now(),
  id = newId(),
): NamedPage[] {
  return [...list, { id, kind: p.kind, title: p.title, page: p.page, createdAt: now, updatedAt: now }];
}

export function renameNamedPage(list: readonly NamedPage[], id: string, title: string, now = Date.now()): NamedPage[] {
  return list.map((n) => (n.id === id ? { ...n, title, updatedAt: Math.max(now, n.updatedAt + 1) } : n));
}

export function deleteNamedPage(list: readonly NamedPage[], id: string, now = Date.now()): NamedPage[] {
  return list.map((n) => (n.id === id ? { ...n, deleted: true, updatedAt: Math.max(now, n.updatedAt + 1) } : n));
}

export function visibleNamed(list: readonly NamedPage[], kind: NamedPage['kind']): NamedPage[] {
  return list.filter((n) => !n.deleted && n.kind === kind);
}

/**
 * 論理ページ(0始まり)が属する章。目次(kind: 'toc')のうち、そのページ以前で最後のもの。
 * 目次が無い、または最初の目次より前なら null。
 */
export function chapterTitleAt(
  chapters: readonly { title: string; index: number }[],
  index: number,
): string | null {
  let best: { title: string; index: number } | null = null;
  for (const c of chapters) if (c.index <= index && (!best || c.index >= best.index)) best = c;
  return best ? best.title : null;
}
