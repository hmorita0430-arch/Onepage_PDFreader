/**
 * Google Cloud の設定値。いずれも「公開される前提」の値で、クライアントシークレットは使わない。
 * APIキーはリファラーとAPIを制限して使う(要件定義書 5章)。値は .env(コミットしない)で与える。
 */
export const config = {
  clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '',
  apiKey: import.meta.env.VITE_GOOGLE_API_KEY ?? '',
  appId: import.meta.env.VITE_GOOGLE_APP_ID ?? '',
};

export function driveConfigured(): boolean {
  return Boolean(config.clientId && config.apiKey && config.appId);
}
