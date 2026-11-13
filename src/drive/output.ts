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

/** 利用者が選んだ保存先を使えない(消えた・権限が無い・フォルダではない等)。文言は利用者向け。 */
export class DestinationError extends Error {}

export interface ExportDestination {
  id: string;
  name: string;
}

/** 既定の保存先(マイドライブ直下)のフォルダ名 */
export const DEFAULT_OUTPUT_FOLDER = '読書ノート';

/**
 * 書き出し先の起点フォルダのIDを返す。
 * - 保存先が未設定なら、マイドライブ直下の「読書ノート」(無ければ作る)。
 * - 設定済みなら、そのフォルダが今も使えるか(存在・ごみ箱・フォルダか・書き込み権限)を確かめる。
 */
export async function resolveOutputRoot(
  dest: ExportDestination | null,
  token: string,
  f: Fetch = fetch,
): Promise<string> {
  if (!dest) return ensureFolder(DEFAULT_OUTPUT_FOLDER, 'root', token, f);
  const hint = '設定で、保存先を選び直すか「既定に戻す」を押してください。';
  const fields = encodeURIComponent('id,mimeType,trashed,capabilities(canAddChildren)');
  const res = await f(`${API}/${encodeURIComponent(dest.id)}?fields=${fields}&supportsAllDrives=true`, { headers: auth(token) });
  if (res.status === 401) throw new AuthExpiredError();
  if (res.status === 404 || res.status === 403) {
    throw new DestinationError(`保存先のフォルダ「${dest.name}」を開けません(削除された、または権限がありません)。${hint}`);
  }
  if (!res.ok) throw new Error(`保存先の確認に失敗しました(HTTP ${res.status})`);
  const j = (await res.json()) as { id: string; mimeType?: string; trashed?: boolean; capabilities?: { canAddChildren?: boolean } };
  if (j.trashed) throw new DestinationError(`保存先のフォルダ「${dest.name}」は、ごみ箱に入っています。${hint}`);
  if (j.mimeType !== FOLDER) throw new DestinationError(`「${dest.name}」はフォルダではありません。${hint}`);
  if (j.capabilities?.canAddChildren === false) {
    throw new DestinationError(`保存先のフォルダ「${dest.name}」には、書き込む権限がありません。${hint}`);
  }
  return j.id;
}

/** ドライブのファイル名に使えない・紛らわしい文字を置き換える */
export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || '無題';
}
