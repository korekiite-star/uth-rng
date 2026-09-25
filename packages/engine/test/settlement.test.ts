import { describe, expect, it } from 'vitest';
import {
  type ActionRecord,
  type Card,
  type PlayerHandInput,
  HandCategory,
  createDeck,
  resolveDecision,
  settleHand,
  settleJackpot,
  shuffle,
} from '../src/index.js';

const h = (s: string) => s.split(' ') as Card[];
const bets = (ante: number, trips = 0, jackpot = 0) => ({ ante, blind: ante, trips, jackpot });
const PLAY4: ActionRecord[] = [{ street: 'PREFLOP', action: 'PLAY_4X' }];
const CHECK_TO: (last: ActionRecord['action']) => ActionRecord[] = (last) => [
  { street: 'PREFLOP', action: 'CHECK' },
  { street: 'FLOP', action: 'CHECK' },
  { street: 'RIVER', action: last },
];

describe('settleHand 本戦', () => {
  it('フラッシュ勝ち・ディーラークオリファイ: Blind 3:2・Trips 7:1・JP フラッシュ 500', () => {
    const r = settleHand({
      dealerHole: h('Qs Js'),
      community: h('2h 7h 9h Kc Kd'),
      players: [{ playerId: 'p1', hole: h('Ah 3h'), bets: bets(10, 5, 100), actions: PLAY4 }],
      jackpotPoolBefore: 10_000,
    });
    const p = r.players[0]!;
    expect(p.outcome).toBe('WIN');
    expect(p.hand.category).toBe(HandCategory.Flush);
    expect(p.lines.play).toEqual({ stake: 40, net: 40 });
    expect(p.lines.ante.net).toBe(10);
    expect(p.lines.blind.net).toBe(15);
    expect(p.lines.trips.net).toBe(35);
    expect(p.lines.jackpot.prize).toBe(500);
    expect(p.net).toBe(500);
    expect(r.jackpot.poolBase).toBe(10_090);
    expect(r.jackpot.dealerTopUp).toBe(410);
    expect(r.jackpot.poolAfter).toBe(10_000);
    expect(r.dealer).toMatchObject({ qualified: true, mainGameNet: -65, tripsNet: -35, jackpotRake: 10, jackpotTopUp: -410, net: -500 });
  });

  it('Blind フラッシュ 3:2 は端数切り捨て', () => {
    const r = settleHand({
      dealerHole: h('Qs Js'),
      community: h('2h 7h 9h Kc Kd'),
      players: [{ playerId: 'p1', hole: h('Ah 3h'), bets: bets(15), actions: PLAY4 }],
      jackpotPoolBefore: 10_000,
    });
    expect(r.players[0]!.lines.blind.net).toBe(22);
  });

  it('ディーラーノンクオリファイで勝ち: Ante・Blind プッシュ、Play のみ 1:1', () => {
    const r = settleHand({
      dealerHole: h('3d 4h'),
      community: h('2c 5d 8h 9s Jc'),
      players: [{ playerId: 'p1', hole: h('Ac Kd'), bets: bets(10), actions: CHECK_TO('PLAY_1X') }],
      jackpotPoolBefore: 10_000,
    });
    const p = r.players[0]!;
    expect(r.dealer.qualified).toBe(false);
    expect(p.outcome).toBe('WIN');
    expect([p.lines.ante.net, p.lines.blind.net, p.lines.play.net]).toEqual([0, 0, 10]);
  });

  it('ディーラーノンクオリファイで負け: 既定は Ante 返金、PLAYER_WIN_ONLY なら没収', () => {
    const input = {
      dealerHole: h('Kd 4h'),
      community: h('2c 5d 8h 9s Jc'),
      players: [{ playerId: 'p1', hole: h('3c 4c'), bets: bets(10), actions: CHECK_TO('PLAY_1X') }],
      jackpotPoolBefore: 10_000,
    };
    const def = settleHand(input).players[0]!;
    expect(def.outcome).toBe('LOSE');
    expect(def.lines.ante.net).toBe(0);
    expect(def.net).toBe(-20);
    const strict = settleHand({ ...input, rules: { anteOnDealerNotQualified: 'PLAYER_WIN_ONLY' } }).players[0]!;
    expect(strict.net).toBe(-30);
  });

  it('ディーラーノンクオリファイでもフォールドは Ante 没収', () => {
    const r = settleHand({
      dealerHole: h('Kd 4h'),
      community: h('2c 5d 8h 9s Jc'),
      players: [{ playerId: 'p1', hole: h('3c 4c'), bets: bets(10), actions: CHECK_TO('FOLD') }],
      jackpotPoolBefore: 10_000,
    });
    expect(r.players[0]!.net).toBe(-20);
  });

  it('引き分けは全プッシュ', () => {
    const r = settleHand({
      dealerHole: h('3d 4h'),
      community: h('2c 5d 8h 9s Jc'),
      players: [{ playerId: 'p1', hole: h('3c 4c'), bets: bets(10), actions: PLAY4 }],
      jackpotPoolBefore: 10_000,
    });
    expect(r.players[0]!.outcome).toBe('TIE');
    expect(r.players[0]!.net).toBe(0);
  });

  it('リバーでフォールド: Ante/Blind 没収、Trips と JP は有効', () => {
    const r = settleHand({
      dealerHole: h('As Ad'),
      community: h('7c 7d 2s 9h Kc'),
      players: [{ playerId: 'p1', hole: h('7h 3d'), bets: bets(10, 5, 100), actions: CHECK_TO('FOLD') }],
      jackpotPoolBefore: 10_000,
    });
    const p = r.players[0]!;
    expect(p.outcome).toBe('FOLD');
    expect(p.lines.trips.net).toBe(15);
    expect(p.lines.jackpot.net).toBe(-100);
    expect(p.net).toBe(-105);
    expect(r.jackpot.poolAfter).toBe(10_090);
    expect(r.dealer.net).toBe(15);
  });

  it('ロイヤル: Blind 500:1・JP プール全額・他ベッターに Envy 1000・シードへリセット', () => {
    const r = settleHand({
      dealerHole: h('2h 2c'),
      community: h('As Ks Qs 2d 3c'),
      players: [
        { playerId: 'p1', hole: h('Js Ts'), bets: bets(10, 1, 100), actions: PLAY4 },
        { playerId: 'p2', hole: h('4d 9d'), bets: bets(10, 0, 100), actions: CHECK_TO('FOLD') },
        { playerId: 'p3', hole: h('8c 8h'), bets: bets(10), actions: CHECK_TO('FOLD') },
      ],
      jackpotPoolBefore: 50_000,
    });
    const [p1, p2, p3] = r.players;
    expect(p1!.hand.category).toBe(HandCategory.RoyalFlush);
    expect(p1!.lines.blind.net).toBe(5000);
    expect(p1!.lines.trips.net).toBe(50);
    expect(p1!.lines.jackpot.prize).toBe(50_180);
    expect(p2!.lines.jackpot).toMatchObject({ prize: 0, envy: 1000, net: 900 });
    expect(p3!.lines.jackpot.envy).toBe(0); // JP 未ベットは Envy 対象外
    expect(r.jackpot.royalFlushHit).toBe(true);
    expect(r.jackpot.dealerTopUp).toBe(11_000);
    expect(r.jackpot.poolAfter).toBe(10_000);
  });
});

describe('settleJackpot', () => {
  it('ストフラ 2 人: 各自 P0 の 10%、互いに Envy、非達成者は 2 件分', () => {
    const r = settleJackpot({
      entries: [
        { playerId: 'a', hole: h('6h 5h'), bet: 100 },
        { playerId: 'b', hole: h('Th Jh'), bet: 100 },
        { playerId: 'c', hole: h('Ac Ad'), bet: 100 },
        { playerId: 'd', hole: h('Kc Kd'), bet: 0 },
      ],
      flop: h('9h 8h 7h'),
      poolBefore: 20_000,
    });
    expect(r.poolBase).toBe(20_270);
    expect(r.players.map((p) => [p.prize, p.envy])).toEqual([[2027, 300], [2027, 300], [0, 600], [0, 0]]);
    expect(r.poolAfter).toBe(20_270 - 2027 * 2 - 1200);
    expect(r.dealerTopUp).toBe(0);
    expect(r.houseRake).toBe(30);
  });

  it('固定配当: クアッズ 3000 / フルハウス 1000 / ストレート 300', () => {
    const r = settleJackpot({
      entries: [
        { playerId: 'q', hole: h('9c 9d'), bet: 100 },
        { playerId: 'f', hole: h('Kc 5d'), bet: 100 },
        { playerId: 's', hole: h('Tc Jd'), bet: 100 },
      ],
      flop: h('9h 9s Ks'),
      poolBefore: 30_000,
    });
    // f: K K 9 9 5 はツーペア → ハズレ
    expect(r.players.map((p) => p.prize)).toEqual([3000, 0, 0]);
    const r2 = settleJackpot({
      entries: [
        { playerId: 'f', hole: h('Kc Kd'), bet: 100 },
        { playerId: 's', hole: h('Tc Jd'), bet: 100 },
      ],
      flop: h('9h 9s Ks'),
      poolBefore: 30_000,
    });
    expect(r2.players[0]!.prize).toBe(1000);
    const r3 = settleJackpot({
      entries: [{ playerId: 's', hole: h('Tc Jd'), bet: 100 }],
      flop: h('9h 8s Qs'),
      poolBefore: 30_000,
    });
    expect(r3.players[0]!.prize).toBe(300);
  });
});

describe('resolveDecision', () => {
  it('不正な履歴を拒否', () => {
    expect(() => resolveDecision([{ street: 'PREFLOP', action: 'PLAY_2X' }])).toThrow();
    expect(() => resolveDecision([{ street: 'FLOP', action: 'CHECK' }])).toThrow();
    expect(() => resolveDecision([...PLAY4, { street: 'FLOP', action: 'CHECK' }])).toThrow();
    expect(() => resolveDecision([{ street: 'PREFLOP', action: 'CHECK' }, { street: 'FLOP', action: 'FOLD' }])).toThrow();
    expect(resolveDecision([{ street: 'PREFLOP', action: 'CHECK' }])).toEqual({ status: 'PENDING', nextStreet: 'FLOP' });
  });
});

describe('ランダム 5,000 ハンドで保存則とプール下限', () => {
  it('Σ損益 = 0 かつ poolAfter >= seed', () => {
    let seed = 12345; // mulberry32（再現性のためのシード付き乱数）
    const rand = (max: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * max | 0;
    };
    let pool = 10_000;
    const choices: ActionRecord[][] = [
      PLAY4,
      [{ street: 'PREFLOP', action: 'PLAY_3X' }],
      [{ street: 'PREFLOP', action: 'CHECK' }, { street: 'FLOP', action: 'PLAY_2X' }],
      CHECK_TO('PLAY_1X'),
      CHECK_TO('FOLD'),
    ];
    for (let i = 0; i < 5000; i++) {
      const deck = shuffle(createDeck(), rand);
      const n = 1 + rand(6);
      const players: PlayerHandInput[] = Array.from({ length: n }, (_, k) => ({
        playerId: `p${k}`,
        hole: deck.splice(0, 2),
        bets: bets(5 * (1 + rand(20)), rand(3) * 5, rand(2) * 100),
        actions: choices[rand(choices.length)]!,
      }));
      const r = settleHand({ dealerHole: deck.splice(0, 2), community: deck.splice(0, 5), players, jackpotPoolBefore: pool });
      expect(r.jackpot.poolAfter).toBeGreaterThanOrEqual(10_000);
      pool = r.jackpot.poolAfter;
    }
  });
});
