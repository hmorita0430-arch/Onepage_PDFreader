import { config } from '../config';
import { loadScript } from './loadScript';

/**
 * Google Identity Services のトークン方式。リフレッシュトークンは使わない。
 * アクセストークンは約1時間で切れ、再取得には利用者の操作(ボタン)が必要(要件 G-3)。
 * 第1段階の権限は drive.file のみ(ピッカーで選んだPDFの読み取り)。
 * drive.appdata は同期を実装する第3段階で追加する。
 */
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

export type ConnectionState = 'disconnected' | 'connected' | 'expired';

type Listener = (state: ConnectionState) => void;

export class DriveAuth {
  private token: string | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private everConnected = false;
  private client: google.accounts.oauth2.TokenClient | undefined;
  private pending: { resolve: (t: string) => void; reject: (e: Error) => void } | undefined;
  private listeners = new Set<Listener>();

  get state(): ConnectionState {
    if (this.token) return 'connected';
    return this.everConnected ? 'expired' : 'disconnected';
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  /** 有効なトークンがあれば返し、なければ利用者の操作(ポップアップ)で取得する。ボタン操作から呼ぶこと。 */
  async ensureToken(): Promise<string> {
    if (this.token) return this.token;
    return this.requestToken();
  }

  /** 「再接続」ボタン用。 */
  async reconnect(): Promise<string> {
    return this.requestToken();
  }

  private async requestToken(): Promise<string> {
    await loadScript('https://accounts.google.com/gsi/client');
    if (!this.client) {
      this.client = google.accounts.oauth2.initTokenClient({
        client_id: config.clientId,
        scope: SCOPE,
        callback: (res) => {
          const p = this.pending;
          this.pending = undefined;
          if (res.error || !res.access_token) {
            p?.reject(new Error(res.error_description || res.error || '認証に失敗しました'));
            return;
          }
          this.setToken(res.access_token, Number(res.expires_in) || 3600);
          p?.resolve(res.access_token);
        },
        error_callback: (err) => {
          const p = this.pending;
          this.pending = undefined;
          p?.reject(new Error(err.type === 'popup_closed' ? '認証がキャンセルされました' : '認証に失敗しました'));
        },
      });
    }
    const client = this.client;
    return new Promise<string>((resolve, reject) => {
      this.pending = { resolve, reject };
      client.requestAccessToken({ prompt: this.everConnected ? '' : 'consent' });
    });
  }

  private setToken(token: string, expiresInSec: number): void {
    this.token = token;
    this.everConnected = true;
    clearTimeout(this.expiryTimer);
    // 期限の1分前に「切れた」扱いにする(読書は止めない。同期だけ保留する)
    this.expiryTimer = setTimeout(() => this.expire(), Math.max(0, expiresInSec - 60) * 1000);
    this.emit();
  }

  /** トークンが無効になった(401 など)ときにも呼ぶ。 */
  expire(): void {
    this.token = null;
    clearTimeout(this.expiryTimer);
    this.emit();
  }
}
