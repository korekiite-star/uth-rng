/**
 * パイガオの 53 枚（52 枚 + ジョーカー）の山札。
 * 52 枚と同じ乱数列（HMAC-SHA256・棄却サンプリング）で、初期順の最後にジョーカーを足した 53 枚を Fisher–Yates で混ぜる。
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDeck53, fairDeck53 } from '../src/paigow/cards.js';

/** 公開している手順を Node の暗号ライブラリだけで書き直したもの（エンジンのコードは使わない） */
function refDeck53(serverSeed: string, mix: string, handNo: number): string[] {
  let counter = 0;
  let buf = Buffer.alloc(0);
  let pos = 0;
  const u32 = () => {
    if (pos + 4 > buf.length) {
      buf = createHmac('sha256', Buffer.from(serverSeed, 'utf8')).update(`${mix}:${handNo}:${counter++}`, 'utf8').digest();
      pos = 0;
    }
    const v = buf.readUInt32BE(pos);
    pos += 4;
    return v;
  };
  const rint = (n: number) => {
    const lim = Math.floor(2 ** 32 / n) * n;
    for (;;) {
      const v = u32();
      if (v < lim) return v % n;
    }
  };
  const d: string[] = [];
  for (const s of 'shdc') for (const r of '23456789TJQKA') d.push(r + s);
  d.push('Jk');
  for (let i = 52; i > 0; i--) {
    const j = rint(i + 1);
    [d[i], d[j]] = [d[j]!, d[i]!];
  }
  return d;
}

describe('パイガオの 53 枚の山札', () => {
  it('初期順は 52 枚（2s 3s … Ac）の最後にジョーカー', () => {
    const d = createDeck53();
    expect(d).toHaveLength(53);
    expect(d[0]).toBe('2s');
    expect(d[52]).toBe('Jk');
  });

  it('毎回 53 枚そろった並び替えで、同じシードなら同じ山札', () => {
    for (let i = 0; i < 200; i++) {
      const d = fairDeck53(`seed-${i}`, `#drand:${i}:abc`, i + 1);
      expect(new Set(d).size).toBe(53);
      expect(fairDeck53(`seed-${i}`, `#drand:${i}:abc`, i + 1)).toEqual(d);
    }
  });

  it('公開している手順の別実装と、並びまで完全に一致する', () => {
    for (let i = 0; i < 500; i++) {
      const seed = `s${i}`.repeat(8);
      const mix = i % 2 ? `#drand:${32_000_000 + i}:${'ab'.repeat(32)}` : '';
      expect(fairDeck53(seed, mix, i + 1)).toEqual(refDeck53(seed, mix, i + 1));
    }
  });

  it('ジョーカーがどの位置にも同じ確率で来る（カイ二乗、53 か所）', () => {
    const N = 26_500;
    const count = new Array<number>(53).fill(0);
    for (let i = 0; i < N; i++) count[fairDeck53(`u${i}`, '', 1).indexOf('Jk')]!++;
    const e = N / 53;
    const chi = count.reduce((s, x) => s + (x - e) ** 2 / e, 0);
    // 自由度 52 のカイ二乗の 99.9% 点 ≒ 90.6
    expect(chi).toBeLessThan(90.6);
  });
});
