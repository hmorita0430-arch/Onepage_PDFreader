import { config } from '../config';
import { loadScript } from './loadScript';

export interface PickedFile {
  id: string;
  name: string;
}

let pickerLoaded: Promise<void> | undefined;

function loadPicker(): Promise<void> {
  pickerLoaded ??= loadScript('https://apis.google.com/js/api.js').then(
    () =>
      new Promise<void>((resolve, reject) => {
        gapi.load('picker', { callback: () => resolve(), onerror: () => reject(new Error('Picker を読み込めませんでした')) });
      }),
  );
  return pickerLoaded;
}

/** 選択したものを1つ返す。キャンセル時は null。 */
function show(view: google.picker.DocsView, accessToken: string, fallbackName: string, title?: string): Promise<PickedFile | null> {
  return new Promise((resolve) => {
    const builder = new google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(accessToken)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .setLocale('ja')
      .setCallback((data: google.picker.ResponseObject) => {
        const action = data[google.picker.Response.ACTION];
        if (action === google.picker.Action.PICKED) {
          const doc = data[google.picker.Response.DOCUMENTS]?.[0];
          if (doc) {
            resolve({ id: doc[google.picker.Document.ID], name: doc[google.picker.Document.NAME] ?? fallbackName });
            return;
          }
        }
        if (action === google.picker.Action.CANCEL || action === google.picker.Action.PICKED) resolve(null);
      });
    if (title) builder.setTitle(title);
    builder.build().setVisible(true);
  });
}

/** Google 標準のピッカーでPDFを1冊選ぶ(G-1)。キャンセル時は null。 */
export async function pickPdf(accessToken: string): Promise<PickedFile | null> {
  await loadPicker();
  const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
    .setMimeTypes('application/pdf')
    .setIncludeFolders(true)
    .setSelectFolderEnabled(false);
  return show(view, accessToken, '無題のPDF');
}

/**
 * 読書ノートの書き出し先として、ドライブのフォルダを1つ選ぶ。キャンセル時は null。
 * 権限 drive.file は、ピッカーで選んだフォルダにだけ書き込める(選ぶことで、このアプリに許可を与える)。
 */
export async function pickFolder(accessToken: string): Promise<PickedFile | null> {
  await loadPicker();
  const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
    .setIncludeFolders(true)
    .setSelectFolderEnabled(true)
    .setMimeTypes('application/vnd.google-apps.folder');
  return show(view, accessToken, '無題のフォルダ', '読書ノートの保存先フォルダを選ぶ');
}
