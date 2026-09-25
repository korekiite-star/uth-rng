import { describe, expect, it } from 'vitest';
import { type Card, HandCategory, compareHands, createDeck, evaluate5, evaluateBest } from '../src/index.js';

const h = (s: string) => s.split(' ') as Card[];

describe('evaluate5', () => {
  it('ロイヤル / ストフラ / ホイール', () => {
    expect(evaluate5(h('As Ks Qs Js Ts')).category).toBe(HandCategory.RoyalFlush);
    const wheelSF = evaluate5(h('5h 4h 3h 2h Ah'));
    expect(wheelSF.category).toBe(HandCategory.StraightFlush);
    expect(wheelSF.cards.at(-1)).toBe('Ah');
    expect(compareHands(evaluate5(h('6h 5h 4h 3h 2h')), wheelSF)).toBe(1);
    const wheel = evaluate5(h('As 2d 3c 4h 5s'));
    expect(wheel.category).toBe(HandCategory.Straight);
    expect(compareHands(evaluate5(h('2d 3c 4h 5s 6s')), wheel)).toBe(1);
  });

  it('キッカー比較', () => {
    const a = evaluate5(h('Ah Ad Kc 7s 2d'));
    const b = evaluate5(h('As Ac Qc 7d 2c'));
    expect(compareHands(a, b)).toBe(1);
    expect(compareHands(evaluate5(h('Ah Ad Kc 7s 2d')), evaluate5(h('As Ac Kd 7d 2c')))).toBe(0);
  });

  it('全 2,598,960 通りの役分布が理論値と一致', () => {
    const deck = createDeck();
    const counts = new Array(10).fill(0);
    const n = deck.length;
    const hand: Card[] = new Array(5);
    for (let a = 0; a < n; a++) {
      hand[0] = deck[a]!;
      for (let b = a + 1; b < n; b++) {
        hand[1] = deck[b]!;
        for (let c = b + 1; c < n; c++) {
          hand[2] = deck[c]!;
          for (let d = c + 1; d < n; d++) {
            hand[3] = deck[d]!;
            for (let e = d + 1; e < n; e++) {
              hand[4] = deck[e]!;
              counts[evaluate5(hand).category]++;
            }
          }
        }
      }
    }
    expect(counts).toEqual([1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 36, 4]);
  }, 60_000);
});

describe('evaluateBest (7 枚)', () => {
  it('7 枚から最強 5 枚', () => {
    expect(evaluateBest(h('Ah Kh Qh Jh Th 2c 3d')).category).toBe(HandCategory.RoyalFlush);
    const fh = evaluateBest(h('As Ad Ac Ks Kd Kc 2h'));
    expect(fh.category).toBe(HandCategory.FullHouse);
    expect(fh.cards.slice(0, 3).every((c) => c[0] === 'A')).toBe(true);
    expect(evaluateBest(h('2h 5h 9h Kh 6h 7d 8s')).category).toBe(HandCategory.Flush);
  });
});
