import { AuthExpiredError } from './download';

/**
 * ドライブのアプリ専用領域(appDataFolder)への読み書き。権限は drive.appdata のみ。
 * 本1冊につき1ファイル(book-<ドライブのファイルID>.json)。
 */
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

export interface RemoteFile {
  id: string;
  version: string;
}

type Fetch = typeof fetch;

export const fileNameFor = (bookId: string): string => `book-${bookId}.json`;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function check(res: Response, what: string): Promise<Response> {
  if (res.status === 401) throw new AuthExpiredError();
  if (!res.ok) throw new Error(`${what}に失敗しました(HTTP ${res.status})`);
  return res;
}

export async function findBookFile(bookId: string, token: string, f: Fetch = fetch): Promise<RemoteFile | undefined> {
  const name = fileNameFor(bookId).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = `name='${name}' and 'appDataFolder' in parents and trashed=false`;
  const url = `${API}?spaces=appDataFolder&q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id,version)')}&pageSize=1`;
  const res = await check(await f(url, { headers: auth(token) }), '同期データの検索');
  const j = (await res.json()) as { files?: { id: string; version: string }[] };
  const file = j.files?.[0];
  return file ? { id: file.id, version: String(file.version) } : undefined;
}

export async function readJson(id: string, token: string, f: Fetch = fetch): Promise<unknown> {
  const res = await check(await f(`${API}/${encodeURIComponent(id)}?alt=media`, { headers: auth(token) }), '同期データの読み込み');
  return res.json();
}

export async function getVersion(id: string, token: string, f: Fetch = fetch): Promise<string> {
  const res = await check(await f(`${API}/${encodeURIComponent(id)}?fields=version`, { headers: auth(token) }), '同期データの確認');
  return String(((await res.json()) as { version: string }).version);
}

export async function createBookFile(bookId: string, data: unknown, token: string, f: Fetch = fetch): Promise<RemoteFile> {
  const boundary = `b${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const meta = JSON.stringify({ name: fileNameFor(bookId), parents: ['appDataFolder'], mimeType: 'application/json' });
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(data)}\r\n` +
    `--${boundary}--`;
  const res = await check(
    await f(`${UPLOAD}?uploadType=multipart&fields=id,version`, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    }),
    '同期データの保存',
  );
  const j = (await res.json()) as { id: string; version: string };
  return { id: j.id, version: String(j.version) };
}

export async function updateBookFile(id: string, data: unknown, token: string, f: Fetch = fetch): Promise<RemoteFile> {
  const res = await check(
    await f(`${UPLOAD}/${encodeURIComponent(id)}?uploadType=media&fields=id,version`, {
      method: 'PATCH',
      headers: { ...auth(token), 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(data),
    }),
    '同期データの保存',
  );
  const j = (await res.json()) as { id: string; version: string };
  return { id: j.id, version: String(j.version) };
}
