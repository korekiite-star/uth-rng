/**
 * プログレッシブ・ジャックポット（5 枚役・Envy 付き）の精算。純粋関数。
 *
 * 処理順（1 ハンド内で決定的）:
 *   1. 積立   : ベット 1 口ごとに contribution をプールへ、残りをハウス（ディーラー）へ
 *   2. 基準額 : P0 = 積立後のプール額。割合配当（ロイヤル 100% / ストフラ 10%）は P0 に対して計算
 *              ロイヤル複数人は P0 を等分（端数切り捨て）
 *   3. 固定額 : クアッズ 3000 / フルハウス 1000 / フラッシュ 500 / ストレート 300
 *   4. Envy   : ロイヤル・ストフラ達成 1 件ごとに「達成者以外の全 JP ベッター」へ 1000 / 300
 *   5. 補填   : 払い出し後のプールがシード未満なら、ディーラー負担でシードまで補填
 *              （ロイヤル後の「シードへ即時リセット」もこの規則に含まれる）
 * 払い出しはすべてプールから行う。
 */
import type { Card } from './cards.js';
import { type EvaluatedHand, HandCategory, evaluate5 } from './evaluator.js';
import { DEFAULT_RULES, ENVY_BONUS, JACKPOT_PAYTABLE, type RuleConfig } from './paytables.js';

export interface JackpotEntry {
  playerId: string;
  hole: readonly Card[];
  /** 0 またはルールの jackpotBetAmount */
  bet: number;
}

export interface JackpotPlayerResult {
  playerId: string;
  stake: number;
  /** JP 未ベットなら null */
  hand: EvaluatedHand | null;
  prize: number;
  envy: number;
  payout: number;
  /** payout - stake */
  net: number;
}

export type JackpotLedgerKind = 'CONTRIBUTION' | 'PAYOUT' | 'ENVY' | 'TOPUP';

export interface JackpotLedgerEntry {
  kind: JackpotLedgerKind;
  playerId?: string;
  /** プール視点の増減（積立・補填は +、払い出しは -） */
  amount: number;
}

export interface JackpotResult {
  poolBefore: number;
  betCount: number;
  contributions: number;
  /** ハウス取り分（ディーラー利益） */
  houseRake: number;
  /** 積立後のプール（割合配当の基準額 P0） */
  poolBase: number;
  totalPrize: number;
  totalEnvy: number;
  /** ディーラーによるシード補填額 */
  dealerTopUp: number;
  poolAfter: number;
  royalFlushHit: boolean;
  players: JackpotPlayerResult[];
  ledger: JackpotLedgerEntry[];
}

export interface JackpotInput {
  entries: readonly JackpotEntry[];
  flop: readonly Card[];
  poolBefore: number;
  rules?: Partial<RuleConfig>;
}

export function evaluateJackpotHand(hole: readonly Card[], flop: readonly Card[]): EvaluatedHand {
  return evaluate5([...hole, ...flop]);
}

export function settleJackpot(input: JackpotInput): JackpotResult {
  const rules = { ...DEFAULT_RULES, ...input.rules };
  const { entries, flop, poolBefore } = input;
  if (flop.length !== 3) throw new Error('flop must be 3 cards');
  assertChip(poolBefore, 'poolBefore');

  const bettors = entries.filter((e) => {
    if (e.bet !== 0 && e.bet !== rules.jackpotBetAmount) {
      throw new Error(`jackpot bet must be 0 or ${rules.jackpotBetAmount}: ${e.playerId}`);
    }
    return e.bet > 0;
  });

  const ledger: JackpotLedgerEntry[] = [];
  const betCount = bettors.length;
  const contributions = betCount * rules.jackpotContribution;
  const houseRake = betCount * (rules.jackpotBetAmount - rules.jackpotContribution);
  for (const b of bettors) {
    ledger.push({ kind: 'CONTRIBUTION', playerId: b.playerId, amount: rules.jackpotContribution });
  }
  const poolBase = poolBefore + contributions;

  const hands = new Map(bettors.map((b) => [b.playerId, evaluateJackpotHand(b.hole, flop)]));
  const royalCount = [...hands.values()].filter((h) => h.category === HandCategory.RoyalFlush).length;

  const prizes = new Map<string, number>();
  for (const b of bettors) {
    const hand = hands.get(b.playerId)!;
    const rule = JACKPOT_PAYTABLE[hand.category];
    let prize = 0;
    if (rule?.type === 'FIXED') prize = rule.amount;
    else if (rule?.type === 'POOL_SHARE') {
      const share = Math.floor((poolBase * rule.percent) / 100);
      prize = hand.category === HandCategory.RoyalFlush ? Math.floor(share / royalCount) : share;
    }
    prizes.set(b.playerId, prize);
    if (prize > 0) ledger.push({ kind: 'PAYOUT', playerId: b.playerId, amount: -prize });
  }

  const envies = new Map<string, number>(bettors.map((b) => [b.playerId, 0]));
  for (const hitter of bettors) {
    const bonus = ENVY_BONUS[hands.get(hitter.playerId)!.category];
    if (!bonus) continue;
    for (const other of bettors) {
      if (other.playerId === hitter.playerId) continue;
      envies.set(other.playerId, envies.get(other.playerId)! + bonus);
    }
  }
  for (const [playerId, envy] of envies) {
    if (envy > 0) ledger.push({ kind: 'ENVY', playerId, amount: -envy });
  }

  const totalPrize = sum(prizes.values());
  const totalEnvy = sum(envies.values());
  const afterPayout = poolBase - totalPrize - totalEnvy;
  const dealerTopUp = Math.max(0, rules.jackpotSeed - afterPayout);
  if (dealerTopUp > 0) ledger.push({ kind: 'TOPUP', amount: dealerTopUp });
  const poolAfter = afterPayout + dealerTopUp;

  const players: JackpotPlayerResult[] = entries.map((e) => {
    const stake = e.bet;
    const prize = prizes.get(e.playerId) ?? 0;
    const envy = envies.get(e.playerId) ?? 0;
    return {
      playerId: e.playerId,
      stake,
      hand: hands.get(e.playerId) ?? null,
      prize,
      envy,
      payout: prize + envy,
      net: prize + envy - stake,
    };
  });

  return {
    poolBefore,
    betCount,
    contributions,
    houseRake,
    poolBase,
    totalPrize,
    totalEnvy,
    dealerTopUp,
    poolAfter,
    royalFlushHit: royalCount > 0,
    players,
    ledger,
  };
}

function sum(xs: Iterable<number>): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function assertChip(n: number, label: string): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${label} must be a non-negative integer: ${n}`);
}
