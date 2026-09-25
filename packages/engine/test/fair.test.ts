import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertDistinctCards,
  combineClientSeeds,
  commitOf,
  dealFromDeck,
  fairDeck,
  hmacSha256,
  sha256,
  toHex,
  verifyFair,
} from '../src/index.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('プルーブリーフェア', () => {
  it('SHA-256 / HMAC-SHA256 が Node の crypto（独立した実装）と一致する', () => {
    for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'あいう'.repeat(50)]) {
      expect(toHex(sha256(enc(s)))).toBe(createHash('sha256').update(s).digest('hex'));
    }
    expect(toHex(sha256(enc('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    for (const [k, m] of [
      ['key', 'The quick brown fox jumps over the lazy dog'],
      ['k'.repeat(100), 'msg'],
      ['', ''],
    ] as const) {
      expect(toHex(hmacSha256(enc(k), enc(m)))).toBe(createHmac('sha256', k).update(m).digest('hex'));
    }
  });

  it('同じシードなら同じ山札、1 文字でも違えば別の山札', () => {
    const a = fairDeck('seed', 'u1:x', 1);
    expect(fairDeck('seed', 'u1:x', 1)).toEqual(a);
    expect(fairDeck('seed', 'u1:y', 1)).not.toEqual(a);
    expect(fairDeck('seed', 'u1:x', 2)).not.toEqual(a);
    expect(fairDeck('seee', 'u1:x', 1)).not.toEqual(a);
    expect(a).toHaveLength(52);
    assertDistinctCards(a);
  });

  it('クライアントシードは userId 順に並べて結合（送った順に依存しない）', () => {
    expect(combineClientSeeds({ b: '2', a: '1' })).toBe('a:1|b:2');
    expect(combineClientSeeds({})).toBe('');
  });

  it('検算: コミット一致と配札の復元', () => {
    const serverSeed = 'f'.repeat(64);
    const rec = { handNo: 7, commit: commitOf(serverSeed), serverSeed, clientSeeds: { p1: 'aa', p2: 'bb' }, order: ['p2', 'p1'] };
    const v = verifyFair(rec);
    expect(v.commitOk).toBe(true);
    const deck = fairDeck(serverSeed, 'p1:aa|p2:bb', 7);
    expect(v.deal).toEqual(dealFromDeck(deck, ['p2', 'p1']));
    expect(v.deal.holes['p2']).toEqual(deck.slice(0, 2));
    expect(v.deal.dealer).toEqual(deck.slice(4, 6));
    expect(v.deal.community).toEqual(deck.slice(6, 11));
    expect(verifyFair({ ...rec, serverSeed: 'e'.repeat(64) }).commitOk).toBe(false);
  });

  it('各カードが各位置に一様に来る（2 万回、カイ二乗検定）', () => {
    const N = 20_000;
    // 先頭 11 枚（1 人参加の配札に使う位置）× 52 枚の出現回数
    const counts = Array.from({ length: 11 }, () => new Map<string, number>());
    for (let i = 0; i < N; i++) {
      const d = fairDeck('test-server-seed', `u:${i}`, i);
      for (let p = 0; p < 11; p++) counts[p]!.set(d[p]!, (counts[p]!.get(d[p]!) ?? 0) + 1);
    }
    const exp = N / 52;
    for (const m of counts) {
      let chi = 0;
      for (const c of fairDeck('x', '', 0)) chi += ((m.get(c) ?? 0) - exp) ** 2 / exp;
      // 自由度 51 のカイ二乗の 99.99% 点 ≒ 101。これを超えたら偏りを疑う
      expect(chi).toBeLessThan(101);
    }
  });
});
