# SNS横断検索

複数のSNSをまとめて検索し、1つの画面に表示するアプリ（Vercel用）。

- `api/search.js` : 各SNSのAPIを呼ぶサーバー側の処理（キーは環境変数）
- `public/index.html` : 画面
- `.env.example` : 設定できる環境変数の一覧

APIキーやパスワードは Vercel の環境変数に設定します。このリポジトリには含めません。
