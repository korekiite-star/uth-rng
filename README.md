# 乱数・シャッフルのコード（レビュー用）

UTH の山札がどう作られるかの全体と、見るべきファイルの一覧です。

## 仕組み（1 ハンド）

1. **サーバーシード**: ベット受付の開始時に、Web Crypto の `crypto.getRandomValues` で 32 バイト（256 ビット）を作る（Cloudflare Workers の暗号用乱数）。
   その SHA-256（コミット）だけを全員に公開し、シード自体は精算まで秘密にする。
2. **クライアントシード**: 各プレイヤーのブラウザがベット確定時に `crypto.getRandomValues` で 16 バイトを作って送る。
3. **山札**: 両方のシードを HMAC-SHA256 に入れた出力を乱数列にし、剰余バイアスを棄却サンプリングで除いた一様整数で Fisher–Yates シャッフル。
4. **配札**: 山札の先頭から、参加者（着席順）に 2 枚ずつ → ディーラー 2 枚 → ボード 5 枚。
5. **公開**: 精算後にサーバーシードを公開。誰でもコミットとの一致と、配られたカードとの一致を計算で確かめられる。

つまり、シャッフル自体は決定的（シードが同じなら同じ山札）な計算で、ランダムさの源は
「サーバーの 256 ビットの暗号用乱数」と「各プレイヤーの 128 ビットの暗号用乱数」です。
サーバーはコミットを先に出しているので後から山札を選び直せず、プレイヤーの乱数も混ざるので事前に山札を決めることもできません。

## ファイル

| ファイル | 中身 |
| --- | --- |
| `packages/engine/src/fair.ts` | SHA-256 / HMAC-SHA256（外部ライブラリなしの実装）、シード生成、乱数列、山札の作成、配札、検算 |
| `packages/engine/src/cards.ts` | 52 枚の初期順、`shuffle`（Fisher–Yates）、`cryptoRandomInt`（棄却サンプリング） |
| `apps/server/src/room.ts` | 実際にハンドで使っている箇所（`newFair` / ディール処理 / 精算後の公開 `fairRecord`） |
| `apps/web/src/lib/fairSeeds.ts` | ブラウザ側のクライアントシード |
| `apps/web/public/verify_hand.py` | 同じ計算を Python の標準ライブラリだけで書いた独立実装（1 ハンドの検算） |
| `packages/engine/test/fair.test.ts` | SHA-256 / HMAC が Node の crypto と一致するか、各位置のカードの一様性（カイ二乗） |
| `packages/engine/test/fair-python.test.ts` | TypeScript 版と Python 版が同じ山札を出すか |
| `scripts/fairness/report.ts` `render.ts` | 10 万ハンドの統計レポート（52 枚 × 配る位置の一様性、役の出現率、勝敗の対称性、連続ハンドの独立性） |

## 自分で確かめる方法

### このフォルダ（レビュー用に切り出したもの）だけで

```bash
# Node.js 22 以上
cd packages/engine
npm install
npx vitest run          # SHA-256 / HMAC の一致、一様性、Python 版との一致、役判定の全数検査など 22 件

python ../../apps/web/public/verify_hand.py hand.json   # 1 ハンドの検算（Python 3、標準ライブラリだけ）
```

`scripts/fairness/` の統計レポートは読む用です（実行にはリポジトリ全体が必要。見たければ GitHub の閲覧権限を渡せます）。

### リポジトリ全体では

```bash
# 依存を入れる（Node.js 22 以上）
npm install

# 単体テスト（SHA-256 / HMAC の一致、一様性、Python との一致を含む）
npm -w @uth/engine test

# 好きな文字列をクライアントシードにして N ハンド配り、統計レポートを作る
npm run fairness -- run --client-seed "好きな文字列" --hands 100000 --new
#   → reports/fairness/<日時>/report.html と hands.csv（全ハンド、各行のシード付き）

# 1 ハンドだけ Python で検算（hand.json はアプリの「検証」画面の JSON）
python apps/web/public/verify_hand.py hand.json
```

`hands.csv` の各行は `server_seed` とクライアントシードから `verify_hand.py` で再計算できます
（clientSeeds = {"player": <クライアントシード>}、order = ["player"]、handNo = 行の番号）。
