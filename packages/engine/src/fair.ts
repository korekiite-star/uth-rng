/**
 * プルーブリーフェア（検証可能な公正さ）。
 *
 * 1 ハンドの流れ:
 *   1. ベット受付の開始時、サーバーが秘密の「サーバーシード」を決め、その SHA-256（コミット）だけを全員に公開する
 *   2. 各プレイヤーはベット確定時に自分の「クライアントシード」を送る（サーバーは事前に知り得ない）
 *   3. ディール時、両方のシードから決まった手順で山札を作る
 *   4. 精算後にサーバーシードを公開する。誰でも
 *        ・SHA-256(サーバーシード) が事前のコミットと一致するか
 *        ・シードから計算した山札・配札が、実際に配られたカードと一致するか
 *      を確かめられる。サーバーはベットや手札を見てから山札を変えられない
 *
 * 山札の計算手順（他の言語でも同じ結果になるよう、単純な標準部品だけで組む）:
 *   commit      = hex(SHA-256(utf8(serverSeed)))
 *   clientSeeds = 参加者を userId の昇順に並べ、"userId:seed" を "|" でつないだ文字列（参加者が送らなければ空）
 *   乱数列      = HMAC-SHA256(key = utf8(serverSeed), msg = utf8(`${clientSeeds}:${handNo}:${counter}`))
 *                 を counter = 0, 1, 2, … と連結し、4 バイトずつビッグエンディアンの uint32 として読む
 *   randomInt(n)= 次の uint32 v が floor(2^32 / n) * n 未満なら v % n、そうでなければ次の v で引き直す
 *   山札        = 初期順 2s 3s … As 2h … Ah 2d … Ad 2c … Ac を Fisher–Yates（i = 51 → 1、j = randomInt(i+1) と交換）
 *   配札        = 山札の先頭から、参加者（着席順）に 2 枚ずつ → ディーラー 2 枚 → ボード 5 枚
 */
import { type Card, type RandomInt, createDeck, shuffle } from './cards.js';

// ------------------------------------------------------------------ SHA-256 / HMAC（同期版。Workers・ブラウザ・Node で同じコード）

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const bitLen = data.length * 8;
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 2 ** 32));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e! >>> 6) | (e! << 26)) ^ ((e! >>> 11) | (e! << 21)) ^ ((e! >>> 25) | (e! << 7));
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (hh! + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = ((a! >>> 2) | (a! << 30)) ^ ((a! >>> 13) | (a! << 19)) ^ ((a! >>> 22) | (a! << 10));
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a!) >>> 0;
    h[1] = (h[1]! + b!) >>> 0;
    h[2] = (h[2]! + c!) >>> 0;
    h[3] = (h[3]! + d!) >>> 0;
    h[4] = (h[4]! + e!) >>> 0;
    h[5] = (h[5]! + f!) >>> 0;
    h[6] = (h[6]! + g!) >>> 0;
    h[7] = (h[7]! + hh!) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]!);
  return out;
}

export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const block = new Uint8Array(64);
  block.set(key.length > 64 ? sha256(key) : key);
  const inner = new Uint8Array(64 + msg.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i]! ^ 0x36;
    outer[i] = block[i]! ^ 0x5c;
  }
  inner.set(msg, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

const utf8 = (s: string) => new TextEncoder().encode(s);
export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// ------------------------------------------------------------------ シード

/** サーバーシード（32 バイトの乱数を 16 進 64 文字で） */
export function newServerSeed(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return toHex(b);
}

/** クライアントシード（ブラウザで作る。16 バイトを 16 進 32 文字で） */
export function newClientSeed(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return toHex(b);
}

export function isValidClientSeed(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);
}

/** コミット = SHA-256(サーバーシード) の 16 進 */
export function commitOf(serverSeed: string): string {
  return toHex(sha256(utf8(serverSeed)));
}

/** 参加者のクライアントシードを 1 本の文字列に（userId の昇順、"userId:seed" を "|" でつなぐ） */
export function combineClientSeeds(seeds: Readonly<Record<string, string>>): string {
  return Object.keys(seeds)
    .sort()
    .map((id) => `${id}:${seeds[id]}`)
    .join('|');
}

// ------------------------------------------------------------------ 山札

/** シードから決まる一様乱数（HMAC-SHA256 の出力を 4 バイトずつ使い、剰余バイアスは棄却サンプリングで除く） */
export function fairRandom(serverSeed: string, clientSeeds: string, handNo: number): RandomInt {
  const key = utf8(serverSeed);
  let counter = 0;
  let buf: Uint8Array = new Uint8Array(0);
  let pos = 0;
  const nextU32 = (): number => {
    if (pos + 4 > buf.length) {
      buf = hmacSha256(key, utf8(`${clientSeeds}:${handNo}:${counter++}`));
      pos = 0;
    }
    const v = ((buf[pos]! << 24) | (buf[pos + 1]! << 16) | (buf[pos + 2]! << 8) | buf[pos + 3]!) >>> 0;
    pos += 4;
    return v;
  };
  return (n) => {
    const limit = Math.floor(2 ** 32 / n) * n;
    for (;;) {
      const v = nextU32();
      if (v < limit) return v % n;
    }
  };
}

export function fairDeck(serverSeed: string, clientSeeds: string, handNo: number): Card[] {
  return shuffle(createDeck(), fairRandom(serverSeed, clientSeeds, handNo));
}

export interface FairDeal {
  holes: Record<string, Card[]>;
  dealer: Card[];
  community: Card[];
}

/** 山札の先頭から: 参加者（order の順）に 2 枚ずつ → ディーラー 2 枚 → ボード 5 枚 */
export function dealFromDeck(deck: readonly Card[], order: readonly string[]): FairDeal {
  const d = deck.slice();
  const holes: Record<string, Card[]> = {};
  for (const id of order) holes[id] = d.splice(0, 2);
  return { holes, dealer: d.splice(0, 2), community: d.splice(0, 5) };
}

/** 公開された情報から 1 ハンドを検算する */
export interface FairRecord {
  handNo: number;
  commit: string;
  serverSeed: string;
  /** userId → クライアントシード */
  clientSeeds: Record<string, string>;
  /** 配った順（着席順）の userId */
  order: string[];
}

export function verifyFair(r: FairRecord): { commitOk: boolean; deal: FairDeal; deck: Card[] } {
  const deck = fairDeck(r.serverSeed, combineClientSeeds(r.clientSeeds), r.handNo);
  return { commitOk: commitOf(r.serverSeed) === r.commit, deal: dealFromDeck(deck, r.order), deck };
}
