import { config } from '../config';
import { loadScript } from './loadScript';

/**
 * Google Identity Services のトークン方式。リフレッシュトークンは使わない。
 * アクセストークンは約1時間で切れ、再取得には利用者の操作が必要(要件 G-3)。
 * 権限は2つだけ: drive.file(ピッカーで選んだPDFの読み取り・出力フォルダへの書き込み)と、
 * drive.appdata(しおり・設定などの同期データ。アプリ専用領域)。
 *
 * アクセストークンは、有効期限(約1時間)の間だけ端末内に保存し、アプリを開き直しても接続を引き継ぐ。
 * 保存するのはこの短命のトークンだけで、期限が切れれば使えない。「接続情報を消す」で即座に消せる。
 */
const SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata';
const STORE_KEY = 'drive-auth:v1';
/** 期限のこの時間前に「切れた」扱いにする(読書は止めない。同期だけ保留する) */
const EXPIRY_MARGIN_MS = 60_000;

export type ConnectionState = 'disconnected' | 'connected' | 'expired';

type Listener = (state: ConnectionState) => void;

interface Stored {
  token: string | null;
  expiresAt: number;
  /** 一度でも接続したことがあるか(あれば、切れたときに「再接続」として扱う) */
  connected: boolean;
}

export class DriveAuth {
  private token: string | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private everConnected = false;
  private client: google.accounts.oauth2.TokenClient | undefined;
  private inflight: Promise<string> | undefined;
  private pending: { resolve: (t: string) => void; reject: (e: Error) => void } | undefined;
  private listeners = new Set<Listener>();

  constructor() {
    this.restore();
  }

  get state(): ConnectionState {
    if (this.token) return 'connected';
    return this.everConnected ? 'expired' : 'disconnected';
  }

  /** 有効なアクセストークン。切れている/未接続なら null(同期は保留する) */
  currentToken(): string | null {
    return this.token;
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  // ---- 端末内への保存 ----

  private restore(): void {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as Partial<Stored>;
      this.everConnected = Boolean(s.connected);
      if (s.token && typeof s.expiresAt === 'number' && s.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
        this.token = s.token;
        this.scheduleExpiry(s.expiresAt - EXPIRY_MARGIN_MS - Date.now());
      }
    } catch {
      /* 壊れていれば未接続として始める */
    }
  }

  private persist(expiresAt: number): void {
    try {
      const s: Stored = { token: this.token, expiresAt, connected: this.everConnected };
      localStorage.setItem(STORE_KEY, JSON.stringify(s));
    } catch {
      /* 保存できなくても、この回は使える */
    }
  }

  private scheduleExpiry(ms: number): void {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => this.expire(), Math.max(0, ms));
  }

  // ---- 接続 ----

  /** Google のスクリプトを先に読み込んでおく。ポップアップを、操作の直後(許可される間)に開くため。 */
  preload(): Promise<void> {
    return loadScript('https://accounts.google.com/gsi/client').catch(() => undefined);
  }

  /** 有効なトークンがあれば返し、なければ利用者の操作(ポップアップ)で取得する。操作の直後に呼ぶこと。 */
  async ensureToken(): Promise<string> {
    if (this.token) return this.token;
    return this.requestToken();
  }

  /** 「再接続」用。 */
  async reconnect(): Promise<string> {
    return this.requestToken();
  }

  private requestToken(): Promise<string> {
    // 既に要求中なら、それに相乗りする(ポップアップを二重に開かない)
    this.inflight ??= this.doRequest().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async doRequest(): Promise<string> {
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
    this.scheduleExpiry(Math.max(0, expiresInSec * 1000 - EXPIRY_MARGIN_MS));
    this.persist(Date.now() + expiresInSec * 1000);
    this.emit();
  }

  /** トークンが無効になった(401 など)ときにも呼ぶ。保存したトークンも消す。 */
  expire(): void {
    const had = this.token !== null;
    this.token = null;
    clearTimeout(this.expiryTimer);
    this.persist(0);
    if (had) this.emit();
  }

  /** この端末に保存した接続情報をすべて消す(未接続に戻る)。Google 側の許可は取り消さない。 */
  disconnect(): void {
    this.token = null;
    this.everConnected = false;
    clearTimeout(this.expiryTimer);
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      /* 何もしない */
    }
    this.emit();
  }
}
