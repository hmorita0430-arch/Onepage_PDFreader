# セットアップ(Google Cloud と公開)

要件定義書 5章の方針に沿った手順。**クライアントシークレットは作らない・使わない**(トークン方式のため不要)。
Google Cloud コンソールの画面名や配置は変わることがあるため、迷ったら公式ドキュメントを優先すること。

## 1. Google Cloud の準備(利用者が行う)

1. プロジェクトを作成する。**プロジェクト番号**を控える(→ `VITE_GOOGLE_APP_ID`)。
2. 次の API を有効にする: **Google Drive API**、**Google Picker API**。
3. OAuth 同意画面を作成する。
   - 公開ステータスは **Testing のまま**にし、**自分のアカウントだけ**をテストユーザーに登録する。
   - スコープは第1段階では `.../auth/drive.file` のみ。(第3段階の同期で `.../auth/drive.appdata` を追加する)
4. 認証情報 → **OAuth クライアント ID**(種類: ウェブアプリケーション)を作成する。
   - 承認済みの JavaScript 生成元: `http://localhost:5173` と、GitHub Pages のオリジン(`https://<ユーザー名>.github.io`)のみ。
   - → クライアントIDを `VITE_GOOGLE_CLIENT_ID` に設定する。
5. 認証情報 → **API キー**を作成し、**制限をかける**。
   - アプリケーションの制限: HTTP リファラー(上記の2つのオリジン)
   - API の制限: Google Picker API
   - → `VITE_GOOGLE_API_KEY` に設定する。

APIキーとクライアントIDは配信されるJavaScriptに含まれて公開される。上記の制限が前提の設計であり、秘密情報ではない。

## 2. ローカルでの実行

```bash
cp .env.example .env   # 値を記入する(.env はコミットされない)
npm install
npm run dev            # http://localhost:5173
```

開発サーバーでは「端末のPDFを開く(開発用)」ボタンが出る。ドライブ設定なしで表示・操作を確認できる(本番ビルドには含まれない)。

## 3. GitHub Pages への公開

1. リポジトリの Settings → Pages で、Source を **GitHub Actions** にする。
2. Settings → Secrets and variables → Actions → **Variables** に `VITE_GOOGLE_CLIENT_ID`、`VITE_GOOGLE_API_KEY`、`VITE_GOOGLE_APP_ID` を登録する(公開される値なので Secrets ではなく Variables)。
3. `main` ブランチへの push で `.github/workflows/deploy.yml` が配信する。

## 4. 実機での確認(第1段階の受け入れ基準)

- 実際の本1冊を Android と Windows で開き、最後までページ送りできる。
- 接続が切れた後(取得から約1時間後)も読書を続けられ、「再接続」で復帰できる。
- 再同意が約7日ごとに必要になるかを、2週間使って記録する(要件定義書 8章)。
