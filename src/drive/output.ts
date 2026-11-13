import { AuthExpiredError } from './download';

/**
 * 読書ノートの書き出し先(マイドライブの通常フォルダ)。権限は drive.file のみ。
 * drive.file は「このアプリが作ったファイル・フォルダ」だけを扱えるため、
 * 同名のフォルダを利用者が手で作っていても見えず、アプリ用に別途作られる。
 */
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';

type Fetch = typeof fetch;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function check(res: Response, what: string): Promise<Response> {
  if (res.status === 401) throw new AuthExpiredError();
  if (!res.ok) throw new Error(`${what}に失敗しました(HTTP ${res.status})`);
  return res;
}

async function findChild(name: string, parentId: string, token: string, f: Fetch, mime?: string): Promise<string | undefined> {
  let q = `name='${esc(name)}' and '${esc(parentId)}' in parents and trashed=false`;
  q += mime === FOLDER ? ` and mimeType='${FOLDER}'` : ` and mimeType!='${FOLDER}'`;
  const url = `${API}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id)')}&pageSize=1`;
  const res = await check(await f(url, { headers: auth(token) }), 'ドライブの確認');
  return ((await res.json()) as { files?: { id: string }[] }).files?.[0]?.id;
}

/** フォルダを探し、無ければ作る。parentId にはマイドライブ直下なら 'root'。 */
export async function ensureFolder(name: string, parentId: string, token: string, f: Fetch = fetch): Promise<string> {
  const found = await findChild(name, parentId, token, f, FOLDER);
  if (found) return found;
  const res = await check(
    await f(`${API}?fields=id`, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] }),
    }),
    'フォルダの作成',
  );
  return ((await res.json()) as { id: string }).id;
}

/** 同名のファイルがあれば中身を更新し、無ければ作る(何度書き出しても重複しない)。 */
export async function upsertFile(
  name: string,
  parentId: string,
  body: Blob,
  mime: string,
  token: string,
  f: Fetch = fetch,
): Promise<string> {
  const existing = await findChild(name, parentId, token, f);
  if (existing) {
    const res = await check(
      await f(`${UPLOAD}/${encodeURIComponent(existing)}?uploadType=media&fields=id`, {
        method: 'PATCH',
        headers: { ...auth(token), 'Content-Type': mime },
        body,
      }),
      'ファイルの更新',
    );
    return ((await res.json()) as { id: string }).id;
  }
  const boundary = `b${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const meta = JSON.stringify({ name, parents: [parentId], mimeType: mime });
  const multipart = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
    body,
    `\r\n--${boundary}--`,
  ]);
  const res = await check(
    await f(`${UPLOAD}?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipart,
    }),
    'ファイルの保存',
  );
  return ((await res.json()) as { id: string }).id;
}

export const folderUrl = (id: string): string => `https://drive.google.com/drive/folders/${id}`;

/** ドライブのファイル名に使えない・紛らわしい文字を置き換える */
export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || '無題';
}
