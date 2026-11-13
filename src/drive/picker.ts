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

/** Google 標準のピッカーでPDFを1冊選ぶ(G-1)。キャンセル時は null。 */
export async function pickPdf(accessToken: string): Promise<PickedFile | null> {
  await loadPicker();
  return new Promise((resolve) => {
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes('application/pdf')
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false);
    const picker = new google.picker.PickerBuilder()
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
            resolve({
              id: doc[google.picker.Document.ID],
              name: doc[google.picker.Document.NAME] ?? '無題のPDF',
            });
            return;
          }
        }
        if (action === google.picker.Action.CANCEL || action === google.picker.Action.PICKED) resolve(null);
      })
      .build();
    picker.setVisible(true);
  });
}
