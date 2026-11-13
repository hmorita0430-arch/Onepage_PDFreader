import { describe, expect, it } from 'vitest';
import { AuthExpiredError } from '../src/drive/download';
import { ensureFolder, folderUrl, safeName, upsertFile } from '../src/drive/output';

interface F { id: string; name: string; parent: string; mime: string; bytes: Uint8Array }

/** 通常のドライブの偽物(フォルダ・ファイル。multipart と media の更新に対応) */
function fakeDrive() {
  const files = new Map<string, F>();
  let seq = 0;
  let status: number | null = null;
  const calls: string[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    if (status) return new Response('', { status });
    const u = new URL(url);
    const m = init?.method ?? 'GET';
    calls.push(`${m} ${u.pathname}`);
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    if (u.pathname === '/drive/v3/files' && m === 'GET') {
      const q = u.searchParams.get('q')!;
      const name = /name='((?:[^'\\]|\\.)*)'/.exec(q)![1]!.replace(/\\(.)/g, '$1');
      const parent = /'((?:[^'\\]|\\.)*)' in parents/.exec(q)![1]!;
      const wantFolder = q.includes("mimeType='application/vnd.google-apps.folder'");
      const hit = [...files.values()].find((f) => f.name === name && f.parent === parent && (f.mime === 'application/vnd.google-apps.folder') === wantFolder);
      return json({ files: hit ? [{ id: hit.id }] : [] });
    }
    if (u.pathname === '/drive/v3/files' && m === 'POST') {
      const b = JSON.parse(String(init!.body));
      const id = `f${++seq}`;
      files.set(id, { id, name: b.name, parent: b.parents[0], mime: b.mimeType, bytes: new Uint8Array() });
      return json({ id });
    }
    if (u.pathname === '/upload/drive/v3/files' && m === 'POST') {
      // multipart をバイト単位で解析する(画像のバイト列を文字列に変換して壊さない)
      const buf = new Uint8Array(await (init!.body as Blob).arrayBuffer());
      const ct = (init!.headers as Record<string, string>)['Content-Type']!;
      const boundary = `--${/boundary=(.+)$/.exec(ct)![1]}`;
      const enc = new TextEncoder();
      const find = (seq: Uint8Array, from: number) => {
        outer: for (let i = from; i <= buf.length - seq.length; i++) {
          for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer;
          return i;
        }
        return -1;
      };
      const crlf2 = enc.encode('\r\n\r\n');
      const bnd = enc.encode(`\r\n${boundary}`);
      const h1 = find(crlf2, 0) + 4; // 1つ目の部分(メタ情報)の本文の始まり
      const e1 = find(bnd, h1);
      const meta = JSON.parse(new TextDecoder().decode(buf.slice(h1, e1)));
      const h2 = find(crlf2, e1) + 4; // 2つ目の部分(本体)の本文の始まり
      const e2 = buf.length - enc.encode(`\r\n${boundary}--`).length;
      const id = `f${++seq}`;
      files.set(id, { id, name: meta.name, parent: meta.parents[0], mime: meta.mimeType, bytes: buf.slice(h2, e2) });
      return json({ id });
    }
    if (u.pathname.startsWith('/upload/drive/v3/files/') && m === 'PATCH') {
      const id = decodeURIComponent(u.pathname.split('/').pop()!);
      files.get(id)!.bytes = new Uint8Array(await (init!.body as Blob).arrayBuffer());
      return json({ id });
    }
    return new Response('', { status: 400 });
  }) as unknown as typeof fetch;
  return { fn, files, calls, fail: (s: number | null) => (status = s) };
}

describe('ensureFolder', () => {
  it('無ければ作り、あれば同じものを返す(重複して作らない)', async () => {
    const d = fakeDrive();
    const a = await ensureFolder('読書ノート', 'root', 'tok', d.fn);
    const b = await ensureFolder('読書ノート', 'root', 'tok', d.fn);
    expect(b).toBe(a);
    expect([...d.files.values()].filter((f) => f.name === '読書ノート')).toHaveLength(1);
    expect(d.files.get(a)!.parent).toBe('root');
  });
  it('同じ名前でも、親が違えば別のフォルダ', async () => {
    const d = fakeDrive();
    const root = await ensureFolder('読書ノート', 'root', 'tok', d.fn);
    const book = await ensureFolder('テスト本', root, 'tok', d.fn);
    const images = await ensureFolder('images', book, 'tok', d.fn);
    expect(d.files.get(images)!.parent).toBe(book);
    expect(d.files.get(book)!.parent).toBe(root);
  });
  it("名前に ' や \\ を含んでも検索できる", async () => {
    const d = fakeDrive();
    const a = await ensureFolder("O'Reilly\\本", 'root', 'tok', d.fn);
    expect(await ensureFolder("O'Reilly\\本", 'root', 'tok', d.fn)).toBe(a);
  });
});

describe('upsertFile', () => {
  it('新規は作成し、同名があれば中身を更新する(重複しない)', async () => {
    const d = fakeDrive();
    const folder = await ensureFolder('x', 'root', 'tok', d.fn);
    const id1 = await upsertFile('読書ノート.md', folder, new Blob(['# 初版']), 'text/markdown', 'tok', d.fn);
    expect(new TextDecoder().decode(d.files.get(id1)!.bytes)).toBe('# 初版');
    const id2 = await upsertFile('読書ノート.md', folder, new Blob(['# 更新後']), 'text/markdown', 'tok', d.fn);
    expect(id2).toBe(id1);
    expect(new TextDecoder().decode(d.files.get(id1)!.bytes)).toBe('# 更新後');
    expect([...d.files.values()].filter((f) => f.name === '読書ノート.md')).toHaveLength(1);
  });
  it('バイナリ(画像)も欠けずに保存される', async () => {
    const d = fakeDrive();
    const folder = await ensureFolder('images', 'root', 'tok', d.fn);
    const bytes = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) % 256); // 改行や境界に似た値を含む
    const id = await upsertFile('p.jpg', folder, new Blob([bytes], { type: 'image/jpeg' }), 'image/jpeg', 'tok', d.fn);
    expect(d.files.get(id)!.bytes).toEqual(bytes);
  });
});

describe('エラー', () => {
  it('401 は接続切れ', async () => {
    const d = fakeDrive();
    d.fail(401);
    await expect(ensureFolder('x', 'root', 'tok', d.fn)).rejects.toBeInstanceOf(AuthExpiredError);
  });
  it('その他は通常のエラー', async () => {
    const d = fakeDrive();
    d.fail(403);
    await expect(ensureFolder('x', 'root', 'tok', d.fn)).rejects.toThrow(/HTTP 403/);
  });
});

describe('補助', () => {
  it('ファイル名の安全化', () => {
    expect(safeName('a/b:c*?.pdf')).toBe('a_b_c__.pdf');
    expect(safeName('   ')).toBe('無題');
    expect(safeName('x'.repeat(300))).toHaveLength(100);
  });
  it('フォルダのURL', () => {
    expect(folderUrl('abc')).toBe('https://drive.google.com/drive/folders/abc');
  });
});
