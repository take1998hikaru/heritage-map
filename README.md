# 世界遺産 地図チェック（PWA）

世界遺産検定の学習用PWA。スマホのホーム画面から起動でき、オフライン参照も可能（PWAインストール後）。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | パスワードゲート（合言葉入力画面） |
| `map.html` | 地図本体（生成元: `世界遺産検定/世界遺産_地図.html`） |
| `quiz.html` | 過去問クイズ（生成元: `世界遺産検定/クイズ.html`） |
| `manifest.json` | PWAマニフェスト |
| `icon-192.png`, `icon-512.png` | アプリアイコン |
| `deploy.py` | HTMLを公開用に加工するスクリプト |

## 更新ワークフロー

### 1. 本体データを更新
```
cd ../世界遺産検定/地図ツール
python generate_map.py
```

### 2. 公開用にビルド
```
cd ../../heritage-map
python deploy.py
```
これで `map.html` / `quiz.html` / `index.html` が最新データで再構築されます。

### 3. GitHubへpush
```
git add -A
git commit -m "Update: 〇〇を修正"
git push
```
push から数十秒〜1分でGitHub Pagesが更新されます。

## パスワード変更

```
python deploy.py --password '新しいパスワード'
```
→ `index.html` のハッシュが差し替わります。commit+push で反映。

**注意**: 既にスマホで合言葉を通した人は、localStorage に旧トークンが残っているので自動で入れたままになります（再認証は不要）。他の端末からの新規アクセスは新しいパスワードが必要になります。

## GitHub Pages セットアップ（初回のみ）

1. GitHubで新規repo `heritage-map` を作成（Publicでよい）
2. ローカルで:
   ```
   cd heritage-map
   git init
   git add -A
   git commit -m "Initial deploy"
   git branch -M main
   git remote add origin https://github.com/<username>/heritage-map.git
   git push -u origin main
   ```
3. GitHubのリポジトリ → **Settings** → **Pages**:
   - Source: `Deploy from a branch`
   - Branch: `main` / `/ (root)`
   - Save
4. 数分待つと `https://<username>.github.io/heritage-map/` でアクセス可能に

## スマホでの使い方

1. ブラウザでPages URLを開く
2. パスワードを入力して入る
3. **iPhone (Safari)**: 共有ボタン → **ホーム画面に追加**
4. **Android (Chrome)**: メニュー → **ホーム画面に追加**（自動ポップアップが出ることも）
5. ホーム画面のアイコンをタップ → 全画面で地図が起動

## セキュリティについて

これはクライアント側パスワードゲートで、**暗号学的な保護ではありません**。

- ✅ 防げるもの: 検索エンジンへの露出、URL共有による漏洩、カジュアルなアクセス
- ❌ 防げないもの: ソース閲覧・開発者ツール・直接HTMLダウンロード

検定事務局の過去問は著作物なので、URL・パスワードを他人に共有しない運用が前提です。
