import { describe, expect, it } from 'vitest';
import { AuthExpiredError } from '../src/drive/download';
import { isSyncable, parseRemote, syncBook } from '../src/sync/remote';
import { stableStringify } from '../src/sync/merge';
import { addNamedPage } from '../src/model/named';
import { newBookSyncDocument, type BookSyncDocument } from '../src/model/types';

/** appDataFolder の偽物。ファイルごとに version を持ち、更新のたびに増やす。 */
function fakeDrive() {
  const files = new Map<string, { name: string; json: string; version: number }>();
  let seq = 0;
  let onBeforeVersionCheck: (() => void) | undefined;
  let failWith: number | null = null;
  const fn = (async (url: string, init?: RequestInit) => {
    if (failWith) return new Response('', { status: failWith });
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    if (u.pathname === '/drive/v3/files' && method === 'GET') {
      const name = /name='((?:[^'\\]|\\.)*)'/.exec(u.searchParams.get('q') ?? '')?.[1]?.replace(/\\(.)/g, '$1');
      const hit = [...files.entries()].find(([, v]) => v.name === name);
      return json({ files: hit ? [{ id: hit[0], version: String(hit[1].version) }] : [] });
    }
    if (u.pathname.startsWith('/drive/v3/files/') && method === 'GET') {
      const id = decodeURIComponent(u.pathname.split('/').pop()!);
      const f = files.get(id);
      if (!f) return new Response('', { status: 404 });
      if (u.searchParams.get('alt') === 'media') return new Response(f.json, { status: 200 });
      onBeforeVersionCheck?.();
      return json({ version: String(files.get(id)!.version) });
    }
    if (u.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const parts = String(init?.body).split(/--b[^\r\n]*/).filter((p) => p.includes('Content-Type'));
      const meta = JSON.parse(parts[0]!.split('\r\n\r\n')[1]!.trim());
      const data = parts[1]!.split('\r\n\r\n')[1]!.trim();
      const id = `id${++seq}`;
      files.set(id, { name: meta.name, json: data, version: 1 });
      return json({ id, version: '1' });
    }
    if (u.pathname.startsWith('/upload/drive/v3/files/') && method === 'PATCH') {
      const id = decodeURIComponent(u.pathname.split('/').pop()!);
      const f = files.get(id)!;
      f.json = String(init?.body);
      f.version++;
      return json({ id, version: String(f.version) });
    }
    return new Response('', { status: 400 });
  }) as unknown as typeof fetch;
  return {
    fn,
    files,
    setFail: (s: number | null) => (failWith = s),
    beforeVersionCheck: (cb: (() => void) | undefined) => (onBeforeVersionCheck = cb),
    remoteDoc: (): BookSyncDocument => JSON.parse([...files.values()][0]!.json),
  };
}

const mk = (title: string, id: string, t: number): BookSyncDocument => ({
  ...newBookSyncDocument('FILE1'),
  namedPages: addNamedPage([], { kind: 'bookmark', title, page: { pdfPage: 2, side: 'R' } }, t, id),
});

describe('syncBook', () => {
  it('ドライブに何も無ければ作成する', async () => {
    const d = fakeDrive();
    const r = await syncBook(mk('A', 'a', 100), 'tok', d.fn);
    expect(r.uploaded).toBe(true);
    expect(d.files.size).toBe(1);
    expect(d.remoteDoc().namedPages[0]?.title).toBe('A');
  });

  it('同じ内容なら書き込まない', async () => {
    const d = fakeDrive();
    const local = mk('A', 'a', 100);
    await syncBook(local, 'tok', d.fn);
    const r = await syncBook(local, 'tok', d.fn);
    expect(r.uploaded).toBe(false);
    expect([...d.files.values()][0]!.version).toBe(1);
  });

  it('2台が別々にしおりを足しても、どちらも残る(受け入れ基準)', async () => {
    const d = fakeDrive();
    const a = mk('Aのしおり', 'a', 100);
    const b = mk('Bのしおり', 'b', 110);
    const ra = await syncBook(a, 'tok', d.fn); // Aが先に同期
    expect(ra.merged.namedPages).toHaveLength(1);
    const rb = await syncBook(b, 'tok', d.fn); // Bが後から同期 → 両方入る
    expect(rb.merged.namedPages.map((x) => x.id).sort()).toEqual(['a', 'b']);
    const ra2 = await syncBook(ra.merged, 'tok', d.fn); // Aが再同期 → Bの分も受け取る
    expect(ra2.merged.namedPages.map((x) => x.id).sort()).toEqual(['a', 'b']);
    expect(d.remoteDoc().namedPages).toHaveLength(2);
  });

  it('読み込みと書き込みの間に他端末が更新したら、取り込み直して統合し直す(上書きで消さない)', async () => {
    const d = fakeDrive();
    await syncBook(mk('初期', 'seed', 50), 'tok', d.fn);
    const other = { ...mk('他端末', 'other', 120), namedPages: [...mk('初期', 'seed', 50).namedPages, ...mk('他端末', 'other', 120).namedPages] };
    let injected = false;
    d.beforeVersionCheck(() => {
      if (injected) return;
      injected = true; // 版の確認の直前に、他端末が書き込んだことにする
      const f = [...d.files.values()][0]!;
      f.json = JSON.stringify(other);
      f.version++;
    });
    const r = await syncBook(mk('自端末', 'mine', 130), 'tok', d.fn);
    const ids = d.remoteDoc().namedPages.map((x) => x.id).sort();
    expect(ids).toEqual(['mine', 'other', 'seed']);
    expect(r.merged.namedPages).toHaveLength(3);
  });

  it('接続切れ(401)は接続切れとして扱う。ドライブには何も書かない', async () => {
    const d = fakeDrive();
    d.setFail(401);
    await expect(syncBook(mk('A', 'a', 1), 'tok', d.fn)).rejects.toBeInstanceOf(AuthExpiredError);
    expect(d.files.size).toBe(0);
  });

  it('通信エラー(500)は通常のエラー', async () => {
    const d = fakeDrive();
    d.setFail(500);
    await expect(syncBook(mk('A', 'a', 1), 'tok', d.fn)).rejects.toThrow(/HTTP 500/);
  });
});

describe('parseRemote', () => {
  it('欠けた項目を補う', () => {
    const r = parseRemote({ schemaVersion: 1, bookId: 'x', settings: {} }, 'x');
    expect(r.namedPages).toEqual([]);
    expect(r.annotations).toEqual([]);
    expect(r.position).toBeNull();
  });
  it('新しい形式は拒否(上書きで壊さない)', () => {
    expect(() => parseRemote({ schemaVersion: 2, bookId: 'x' }, 'x')).toThrow(/更新/);
  });
  it('別の本・不正な形式は拒否', () => {
    expect(() => parseRemote({ schemaVersion: 1, bookId: 'y' }, 'x')).toThrow();
    expect(() => parseRemote(null, 'x')).toThrow();
    expect(() => parseRemote({}, 'x')).toThrow();
  });
});

describe('isSyncable', () => {
  it('開発用の端末PDFは同期しない', () => {
    expect(isSyncable('local:a.pdf:1')).toBe(false);
    expect(isSyncable('1AbCdEf')).toBe(true);
  });
  it('stableStringify はキー順に依存しない', () => {
    expect(stableStringify({ b: 1, a: { d: 1, c: 2 } })).toBe(stableStringify({ a: { c: 2, d: 1 }, b: 1 }));
  });
});
