# 乱数・シャッフルのコード（レビュー用）

UTH の山札がどう作られるかの全体と、見るべきファイルの一覧です。

## 仕組み（1 ハンド）

1. **サーバーシード**: ベット受付の開始時に、Web Crypto の `crypto.getRandomValues` で 32 バイト（256 ビット）を作る（Cloudflare Workers の暗号用乱数）。
   その SHA-256（コミット）だけを全員に公開し、シード自体は精算まで秘密にする。
2. **クライアントシード**: 各プレイヤーのブラウザがベット確定時に `crypto.getRandomValues` で 16 バイトを作って送る。
3. **確定**: ディーラーがディールを押した瞬間に、参加者とクライアントシードを確定して全員に公開する（以後は変更・取り消し不可）。
   同時に「公開が確定時刻の 1 秒以上あとになる最初の drand quicknet のラウンド」を決めて全員に公開する。
4. **公開乱数**: そのラウンドの値（drand。3 秒ごとに公開される分散型の公開乱数。randomness = SHA-256(BLS 署名)）が公開されるのを待つ。
5. **山札**: サーバーシード・確定したクライアントシード・drand の値を HMAC-SHA256 に入れた出力を乱数列にし、剰余バイアスを棄却サンプリングで除いた一様整数で Fisher–Yates シャッフル。
6. **配札**: 山札の先頭から、参加者（着席順）に 2 枚ずつ → ディーラー 2 枚 → ボード 5 枚。
7. **公開**: 精算後にサーバーシードを公開。誰でもコミットとの一致、drand の値が公式 API と一致すること、配られたカードとの一致を計算で確かめられる。

シャッフル自体は決定的（入力が同じなら同じ山札）な計算で、ランダムさの源は
「サーバーの 256 ビットの暗号用乱数」「各プレイヤーの 128 ビットの暗号用乱数」「drand の公開乱数」です。

- サーバーはコミットを先に出しているので、サーバーシードを後から差し替えられない。
- サーバーは全員のクライアントシードを配る前に知っているが、シードを確定した時点では drand の値はまだ誰も知らない。
  そのため「サクラの席のシードを送り直して都合のいい山札を選ぶ」ことはできない（drand 導入前はこれができてしまう穴があった）。
- drand の値は運営もプレイヤーも決められず、公式 API で誰でも確認できる。

### drand に繋がらないとき（バックアップ）

1. 取得先を 4 つ（api.drand.sh / api2 / api3 / drand.cloudflare.com）順に試し、取れるまで 1 秒ごとに再試行する。どこから取っても同じ値。
2. 確定から 20 秒以内に取れなければ、そのハンドは**配らずに無効**にする（カードは誰にも配られていない。ベットは精算まで残高から引いていないので全額返金）。
   「運営が都合の悪い山札のときだけ取得失敗にする」ことを疑えるよう、無効にしたハンドは**サーバーシードも含めて公開**し、
   検証ページで drand の値を取って「配られるはずだった山札」を誰でも計算できる。drand が実際には動いていた時刻の無効は、それ自体が不正の証拠になる。
3. drand が長時間止まっているときの非常用に、ディーラーは卓の設定（ハンドの合間のみ）で公開乱数を OFF にできる。
   OFF の間は全員の画面に「⚠ 乱数OFF」と表示し、検証ページでも「公開乱数なし」と出る（従来のサーバーシード + クライアントシードだけの方式）。

## ファイル

| ファイル | 中身 |
| --- | --- |
| `packages/engine/src/fair.ts` | SHA-256 / HMAC-SHA256（外部ライブラリなしの実装）、シード生成、乱数列、山札の作成、配札、検算 |
| `packages/engine/src/beacon.ts` | 公開乱数 drand quicknet（ラウンドの選び方、公開時刻、randomness = SHA-256(signature) の確認） |
| `packages/engine/src/cards.ts` | 52 枚の初期順、`shuffle`（Fisher–Yates）、`cryptoRandomInt`（棄却サンプリング） |
| `apps/server/src/room.ts` | 実際にハンドで使っている箇所（`newFair` / ディールでのシード確定と drand 待ち / `deal` / 取得失敗時の無効化 `voidHandForBeacon` / 精算後の公開 `fairRecord`） |
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
npx vitest run          # SHA-256 / HMAC の一致、一様性、Python 版との一致、公開乱数の確認、役判定の全数検査など 25 件

python ../../apps/web/public/verify_hand.py hand.json --online   # 1 ハンドの検算（Python 3、標準ライブラリだけ。--online で drand の公式値とも照合）
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
