import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthExpiredError, CHUNK_SIZE, downloadResumable, fetchFileInfo } from '../src/drive/download';
import { deleteBook, getBlob, getMeta, latestBook, listBooks, saveBook, sortBooks, touchBook, type BookMeta } from '../src/offline/library';
import { getPartial } from '../src/offline/partials';

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);
const FILE = bytes(CHUNK_SIZE * 2 + 1234); // 3断片
const info = { name: 'book.pdf', size: FILE.length, md5: 'abc' };

/** Range に応じて断片を返す偽のドライブ。failAt 回目の呼び出しで 401 を返す。 */
function fakeDrive(opts: { failAt?: number; ignoreRange?: boolean } = {}) {
  let calls = 0;
  const log: string[] = [];
  const fn = (async (_url: string, init?: RequestInit) => {
    calls++;
    const range = (init?.headers as Record<string, string>)?.Range;
    log.push(range ?? 'none');
    if (opts.failAt === calls) return new Response('', { status: 401 });
    if (opts.ignoreRange || !range) return new Response(FILE, { status: 200 });
    const m = /bytes=(\d+)-(\d+)/.exec(range)!;
    return new Response(FILE.slice(Number(m[1]), Number(m[2]) + 1), { status: 206 });
  }) as unknown as typeof fetch;
  return { fn, log, calls: () => calls };
}

beforeEach(async () => {
  indexedDB = new IDBFactory();
  // db.ts は接続をキャッシュするため、新しい factory に合わせて読み直す
  const { resetDbForTest } = await import('../src/offline/db');
  resetDbForTest?.();
});

describe('端末内保存(G-4)', () => {
  it('保存・一覧・取得・削除', async () => {
    await saveBook({ bookId: 'a', name: 'A.pdf', size: 3, md5: null }, new Blob(['abc']));
    await saveBook({ bookId: 'b', name: 'B.pdf', size: 3, md5: 'm' }, new Blob(['xyz']));
    expect((await listBooks()).map((b) => b.bookId).sort()).toEqual(['a', 'b']);
    expect(await (await getBlob('a'))!.text()).toBe('abc');
    expect((await getMeta('b'))?.md5).toBe('m');
    await deleteBook('a');
    expect(await getBlob('a')).toBeUndefined();
    expect(await getMeta('a')).toBeUndefined();
    expect((await listBooks()).map((b) => b.bookId)).toEqual(['b']);
  });

  it('最近開いた順に並ぶ', async () => {
    await saveBook({ bookId: 'a', name: 'A', size: 1, md5: null }, new Blob(['a']));
    await new Promise((r) => setTimeout(r, 5));
    await saveBook({ bookId: 'b', name: 'B', size: 1, md5: null }, new Blob(['b']));
    await new Promise((r) => setTimeout(r, 5));
    await touchBook('a');
    expect((await listBooks()).map((b) => b.bookId)).toEqual(['a', 'b']);
  });
});

describe('再開できる取得', () => {
  it('全体を断片で取得し、内容が一致する。進捗は単調に増える', async () => {
    const d = fakeDrive();
    const seen: number[] = [];
    const blob = await downloadResumable('f1', 't', info, (p) => seen.push(p), undefined, d.fn);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(FILE);
    expect(d.calls()).toBe(3);
    expect(seen[seen.length - 1]).toBe(1);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(await getPartial('f1')).toBeUndefined(); // 完了後は途中経過を消す
  });

  it('接続が切れても、再接続後は取得済みの断片を飛ばして続きから取得する', async () => {
    const first = fakeDrive({ failAt: 3 }); // 3断片目で 401
    await expect(downloadResumable('f2', 't', info, () => {}, undefined, first.fn)).rejects.toBeInstanceOf(
      AuthExpiredError,
    );
    expect((await getPartial('f2'))?.nextIndex).toBe(2);

    const second = fakeDrive();
    const blob = await downloadResumable('f2', 't2', info, () => {}, undefined, second.fn);
    expect(second.calls()).toBe(1); // 最後の1断片だけ
    expect(second.log[0]).toBe(`bytes=${CHUNK_SIZE * 2}-${FILE.length - 1}`);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(FILE);
  });

  it('ファイルが変わっていたら(md5が違う)最初からやり直す', async () => {
    await expect(
      downloadResumable('f3', 't', info, () => {}, undefined, fakeDrive({ failAt: 3 }).fn),
    ).rejects.toBeInstanceOf(AuthExpiredError);
    const again = fakeDrive();
    await downloadResumable('f3', 't', { ...info, md5: 'changed' }, () => {}, undefined, again.fn);
    expect(again.calls()).toBe(3);
  });

  it('Range が無視されて全体が返ってきても完了できる', async () => {
    const d = fakeDrive({ ignoreRange: true });
    const blob = await downloadResumable('f4', 't', info, () => {}, undefined, d.fn);
    expect(blob.size).toBe(FILE.length);
    expect(d.calls()).toBe(1);
  });
});

describe('fetchFileInfo', () => {
  it('名前・サイズ・md5 を返し、401 は接続切れとして扱う', async () => {
    const ok = (async () =>
      new Response(JSON.stringify({ name: 'x.pdf', size: '42', md5Checksum: 'h' }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchFileInfo('id', 't', ok)).toEqual({ name: 'x.pdf', size: 42, md5: 'h' });
    const expired = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    await expect(fetchFileInfo('id', 't', expired)).rejects.toBeInstanceOf(AuthExpiredError);
  });
});

const book = (name: string, lastOpenedAt: number, savedAt = 1): BookMeta => ({ bookId: name, name, size: 1, md5: null, savedAt, lastOpenedAt });

describe('保存した本の並べ替えと「続きから読む」', () => {
  const list = [book('b本', 200), book('a本', 100), book('c本', 300)];
  it('最近順: 最後に開いた順', () => {
    expect(sortBooks(list, 'recent').map((b) => b.name)).toEqual(['c本', 'b本', 'a本']);
  });
  it('名前順: 名前の順', () => {
    expect(sortBooks(list, 'name').map((b) => b.name)).toEqual(['a本', 'b本', 'c本']);
  });
  it('名前順: 数字は大きさの順(2巻 < 10巻)、日本語は読みの順', () => {
    const l = [book('本 10巻', 1), book('本 2巻', 2), book('あ本', 3), book('い本', 4)];
    expect(sortBooks(l, 'name').map((b) => b.name)).toEqual(['あ本', 'い本', '本 2巻', '本 10巻']);
  });
  it('元の配列は変えない', () => {
    const copy = [...list];
    sortBooks(list, 'name');
    expect(list).toEqual(copy);
  });
  it('同時刻なら、保存した順で安定', () => {
    expect(sortBooks([book('x', 5, 1), book('y', 5, 2)], 'recent').map((b) => b.name)).toEqual(['y', 'x']);
  });
  it('続きから読む: 最後に開いた本。本が無ければ undefined', () => {
    expect(latestBook(list)?.name).toBe('c本');
    expect(latestBook([])).toBeUndefined();
  });
});
