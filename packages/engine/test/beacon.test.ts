import { describe, expect, it } from 'vitest';
import { DRAND, beaconRoundTime, beaconTargetRound, beaconUrl, isBeaconConsistent } from '../src/index.js';

/** drand quicknet の本物の値（https://api.drand.sh/<chain>/public/32511553 で誰でも確認できる） */
const REAL = {
  round: 32511553,
  randomness: 'c66fd8409b9d1cf45975fb010343fd85b2819dfc667af9b96d36c8cde54b4a2b',
  signature: 'a33532299d07b8a68b04c0631d12750fcc2dc251cdab4458ab0a92c11743a9ebfcdb5c8e533320e97741918e8efdaa86',
};

describe('公開乱数ビーコン（drand quicknet）', () => {
  it('本物の値は randomness = SHA-256(signature)。1 文字でも変えると不一致', () => {
    expect(isBeaconConsistent(REAL)).toBe(true);
    expect(isBeaconConsistent({ ...REAL, randomness: REAL.randomness.replace(/^c/, 'd') })).toBe(false);
    expect(isBeaconConsistent({ ...REAL, signature: REAL.signature.slice(0, -1) })).toBe(false);
  });

  it('ラウンドの公開時刻と、確定時刻から選ぶラウンド（公開が 1 秒以上あと = まだ誰も知らない）', () => {
    expect(beaconRoundTime(1)).toBe(DRAND.genesis * 1000);
    expect(beaconRoundTime(2) - beaconRoundTime(1)).toBe(DRAND.period * 1000);
    for (const offset of [0, 1, 999, 1000, 1001, 2999, 3000, 12345]) {
      const now = beaconRoundTime(REAL.round) + offset;
      const r = beaconTargetRound(now);
      expect(beaconRoundTime(r)).toBeGreaterThanOrEqual(now + 1000);
      expect(beaconRoundTime(r - 1)).toBeLessThan(now + 1000);
      expect(beaconRoundTime(r) - now).toBeLessThanOrEqual(1000 + DRAND.period * 1000);
    }
  });

  it('公式 API の URL', () => {
    expect(beaconUrl(5)).toBe(`https://api.drand.sh/${DRAND.chainHash}/public/5`);
  });
});
