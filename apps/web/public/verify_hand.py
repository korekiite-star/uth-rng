"""
UTH のハンドを検算する（アプリのコードを一切使わない、独立した実装）。

使い方:
  python verify_hand.py hand.json            # 検算だけ（オフライン）
  python verify_hand.py hand.json --online   # 公開乱数（drand）の値を公式 API から取得して照合もする
  （hand.json はアプリの「検証」画面の「JSON をコピー」で取れる内容）

hand.json の形:
  {"handNo": 12, "commit": "...", "serverSeed": "...",
   "clientSeeds": {"userId": "seed", ...}, "order": ["userId", ...],
   "beacon": {"network": "quicknet", "round": 123, "randomness": "...", "signature": "..."}}   # beacon は無いハンドもある

手順（アプリ側 packages/engine/src/fair.ts と同じ）:
  1. SHA-256(serverSeed) がハンド開始前に公開された commit と一致するか
  2. clientSeeds を userId の昇順に "userId:seed" で "|" 連結 → C
     beacon があれば mix = C + "#drand:" + round + ":" + randomness、無ければ mix = C
  3. HMAC-SHA256(serverSeed, "mix:handNo:counter") を乱数列にして Fisher–Yates で山札を作る
  4. 先頭から 参加者に 2 枚ずつ → ディーラー 2 枚 → ボード 5 枚
  beacon の randomness は SHA-256(signature)。値そのものは drand の公開 API と照合できる（--online）
"""
import hashlib
import hmac
import json
import sys
import urllib.request

DRAND_QUICKNET = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"


def verify(r):
    server_seed = r["serverSeed"]
    commit_ok = hashlib.sha256(server_seed.encode()).hexdigest() == r["commit"]

    seeds = r["clientSeeds"]
    mix = "|".join(f"{k}:{seeds[k]}" for k in sorted(seeds))
    beacon = r.get("beacon")
    if beacon:
        mix += f"#drand:{beacon['round']}:{beacon['randomness']}"

    def stream():
        counter = 0
        while True:
            msg = f"{mix}:{r['handNo']}:{counter}".encode()
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


def check_beacon(beacon, online):
    """公開乱数の確認: randomness = SHA-256(signature)、online なら drand の公式 API の値と一致するか"""
    if not beacon:
        return "なし（公開乱数を使っていないハンド）"
    own = hashlib.sha256(bytes.fromhex(beacon["signature"])).hexdigest() == beacon["randomness"]
    msg = f"drand #{beacon['round']}  randomness = SHA-256(signature): {'OK' if own else 'NG'}"
    if online:
        url = f"https://api.drand.sh/{DRAND_QUICKNET}/public/{beacon['round']}"
        with urllib.request.urlopen(url, timeout=10) as res:
            official = json.load(res)
        same = official["randomness"] == beacon["randomness"] and official["signature"] == beacon["signature"]
        msg += f"  公式 API と一致: {'OK' if same else 'NG'}"
    return msg


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as f:
        record = json.load(f)
    commit_ok, holes, dealer, board, deck = verify(record)
    print("コミット一致:", "OK" if commit_ok else "NG（シードがすり替えられている）")
    print("公開乱数:", check_beacon(record.get("beacon"), "--online" in sys.argv))
    for uid, cards in holes.items():
        print(f"  {uid}: {' '.join(cards)}")
    print("  ディーラー:", " ".join(dealer))
    print("  ボード:", " ".join(board))
    print("山札:", " ".join(deck))
