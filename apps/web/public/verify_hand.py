"""
UTH のハンドを検算する（アプリのコードを一切使わない、独立した実装）。

使い方:
  python verify_hand.py hand.json
  （hand.json はアプリの「検証」画面の「JSON をコピー」で取れる内容）

hand.json の形:
  {"handNo": 12, "commit": "...", "serverSeed": "...",
   "clientSeeds": {"userId": "seed", ...}, "order": ["userId", ...]}

手順（アプリ側 packages/engine/src/fair.ts と同じ）:
  1. SHA-256(serverSeed) がハンド開始前に公開された commit と一致するか
  2. HMAC-SHA256(serverSeed, "clientSeeds:handNo:counter") を乱数列にして Fisher–Yates で山札を作る
  3. 先頭から 参加者に 2 枚ずつ → ディーラー 2 枚 → ボード 5 枚
"""
import hashlib
import hmac
import json
import sys


def verify(r):
    server_seed = r["serverSeed"]
    commit_ok = hashlib.sha256(server_seed.encode()).hexdigest() == r["commit"]

    seeds = r["clientSeeds"]
    combined = "|".join(f"{k}:{seeds[k]}" for k in sorted(seeds))

    def stream():
        counter = 0
        while True:
            msg = f"{combined}:{r['handNo']}:{counter}".encode()
            block = hmac.new(server_seed.encode(), msg, hashlib.sha256).digest()
            counter += 1
            for i in range(0, 32, 4):
                yield int.from_bytes(block[i : i + 4], "big")

    s = stream()

    def rand_int(n):
        limit = (2**32 // n) * n
        while True:
            v = next(s)
            if v < limit:
                return v % n

    deck = [rank + suit for suit in "shdc" for rank in "23456789TJQKA"]
    for i in range(51, 0, -1):
        j = rand_int(i + 1)
        deck[i], deck[j] = deck[j], deck[i]

    pos = 0
    holes = {}
    for uid in r["order"]:
        holes[uid] = deck[pos : pos + 2]
        pos += 2
    dealer = deck[pos : pos + 2]
    board = deck[pos + 2 : pos + 7]
    return commit_ok, holes, dealer, board, deck


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as f:
        record = json.load(f)
    commit_ok, holes, dealer, board, deck = verify(record)
    print("コミット一致:", "OK" if commit_ok else "NG（シードがすり替えられている）")
    for uid, cards in holes.items():
        print(f"  {uid}: {' '.join(cards)}")
    print("  ディーラー:", " ".join(dealer))
    print("  ボード:", " ".join(board))
    print("山札:", " ".join(deck))
