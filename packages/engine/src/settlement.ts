/**
 * 1 ハンドの完全精算。純粋関数（同じ入力なら必ず同じ出力、副作用なし）。
 *
 * 入力: ディーラー手札・各プレイヤー手札・コミュニティ 5 枚・ベット額・アクション履歴・現 JP プール
 * 出力: プレイヤーごとのベット別損益 / JP 結果 / ディーラー損益内訳
 *
 * 保存則（毎回検証）: Σプレイヤー純損益 + ディーラー純損益 + プール増減 = 0
 */
import { type ActionRecord, type Decision, resolveDecision } from './actions.js';
import { type Card, assertDistinctCards } from './cards.js';
import { type EvaluatedHand, HandCategory, compareHands, evaluateBest } from './evaluator.js';
import { type JackpotResult, assertChip, settleJackpot } from './jackpot.js';
import { BLIND_PAYTABLE, DEFAULT_RULES, type RuleConfig, TRIPS_PAYTABLE, payOdds } from './paytables.js';

export interface PlayerBets {
  ante: number;
  /** Ante と同額 */
  blind: number;
  trips: number;
  /** 0 または jackpotBetAmount */
  jackpot: number;
}

export interface PlayerHandInput {
  playerId: string;
  hole: readonly Card[];
  bets: PlayerBets;
  actions: readonly ActionRecord[];
}

export interface HandSettlementInput {
  dealerHole: readonly Card[];
  community: readonly Card[];
  players: readonly PlayerHandInput[];
  jackpotPoolBefore: number;
  rules?: Partial<RuleConfig>;
}

export type MainOutcome = 'WIN' | 'LOSE' | 'TIE' | 'FOLD';

/** net: 純増（+勝ち / 0 プッシュ / -stake 没収）。払い戻し額 = stake + net */
export interface BetLineResult {
  stake: number;
  net: number;
}

export interface PlayerSettlement {
  playerId: string;
  hand: EvaluatedHand;
  outcome: MainOutcome;
  decision: Exclude<Decision, { status: 'PENDING' }>;
  lines: {
    ante: BetLineResult;
    blind: BetLineResult;
    play: BetLineResult;
    trips: BetLineResult;
    jackpot: BetLineResult & { prize: number; envy: number; hand: EvaluatedHand | null };
  };
  totalStake: number;
  totalReturn: number;
  net: number;
}

export interface DealerSettlement {
  hand: EvaluatedHand;
  qualified: boolean;
  /** Ante + Blind + Play の損益 */
  mainGameNet: number;
  tripsNet: number;
  /** JP ベットのハウス取り分（+） */
  jackpotRake: number;
  /** JP シード補填（-） */
  jackpotTopUp: number;
  net: number;
}

export interface HandSettlement {
  dealer: DealerSettlement;
  players: PlayerSettlement[];
  jackpot: JackpotResult;
}

export function settleHand(input: HandSettlementInput): HandSettlement {
  const rules: RuleConfig = { ...DEFAULT_RULES, ...input.rules };
  validate(input, rules);

  const { dealerHole, community } = input;
  const dealerHand = evaluateBest([...dealerHole, ...community]);
  const qualified = dealerHand.category >= HandCategory.OnePair;

  const jackpot = settleJackpot({
    entries: input.players.map((p) => ({ playerId: p.playerId, hole: p.hole, bet: p.bets.jackpot })),
    flop: community.slice(0, 3),
    poolBefore: input.jackpotPoolBefore,
    rules,
  });

  const players = input.players.map((p, i): PlayerSettlement => {
    const decision = resolveDecision(p.actions);
    if (decision.status === 'PENDING') {
      throw new Error(`player ${p.playerId} has not finished acting (next: ${decision.nextStreet})`);
    }
    const hand = evaluateBest([...p.hole, ...community]);
    const { ante, blind, trips } = p.bets;
    const lines = {
      ante: { stake: ante, net: 0 },
      blind: { stake: blind, net: 0 },
      play: { stake: 0, net: 0 },
    };

    let outcome: MainOutcome;
    if (decision.status === 'FOLDED') {
      outcome = 'FOLD';
      lines.ante.net = -ante;
      lines.blind.net = -blind;
    } else {
      const play = ante * decision.multiplier;
      lines.play.stake = play;
      const cmp = compareHands(hand, dealerHand);
      if (cmp > 0) {
        outcome = 'WIN';
        lines.play.net = play;
        lines.ante.net = qualified ? ante : 0;
        const odds = BLIND_PAYTABLE[hand.category];
        lines.blind.net = odds ? payOdds(blind, odds) : 0;
      } else if (cmp < 0) {
        outcome = 'LOSE';
        lines.play.net = -play;
        lines.blind.net = -blind;
        lines.ante.net = !qualified && rules.anteOnDealerNotQualified === 'ALWAYS' ? 0 : -ante;
      } else {
        outcome = 'TIE';
      }
    }

    // Trips はフォールドしても有効（プレイヤーの 7 枚役のみで判定）
    const tripsOdds = TRIPS_PAYTABLE[hand.category];
    const tripsLine = { stake: trips, net: trips === 0 ? 0 : tripsOdds ? payOdds(trips, tripsOdds) : -trips };

    const jp = jackpot.players[i]!;
    const jackpotLine = { stake: jp.stake, net: jp.net, prize: jp.prize, envy: jp.envy, hand: jp.hand };

    const all = [lines.ante, lines.blind, lines.play, tripsLine, jackpotLine];
    const totalStake = all.reduce((s, l) => s + l.stake, 0);
    const net = all.reduce((s, l) => s + l.net, 0);

    return {
      playerId: p.playerId,
      hand,
      outcome,
      decision,
      lines: { ...lines, trips: tripsLine, jackpot: jackpotLine },
      totalStake,
      totalReturn: totalStake + net,
      net,
    };
  });

  const mainGameNet = -players.reduce((s, p) => s + p.lines.ante.net + p.lines.blind.net + p.lines.play.net, 0);
  const tripsNet = -players.reduce((s, p) => s + p.lines.trips.net, 0);
  const dealer: DealerSettlement = {
    hand: dealerHand,
    qualified,
    mainGameNet,
    tripsNet,
    jackpotRake: jackpot.houseRake,
    jackpotTopUp: -jackpot.dealerTopUp,
    net: mainGameNet + tripsNet + jackpot.houseRake - jackpot.dealerTopUp,
  };

  const playersNet = players.reduce((s, p) => s + p.net, 0);
  const poolDelta = jackpot.poolAfter - jackpot.poolBefore;
  if (playersNet + dealer.net + poolDelta !== 0) {
    throw new Error(`conservation violated: players ${playersNet}, dealer ${dealer.net}, pool ${poolDelta}`);
  }

  return { dealer, players, jackpot };
}

function validate(input: HandSettlementInput, rules: RuleConfig): void {
  if (input.dealerHole.length !== 2) throw new Error('dealer must have 2 hole cards');
  if (input.community.length !== 5) throw new Error('community must be 5 cards');
  const ids = new Set<string>();
  const cards: Card[] = [...input.dealerHole, ...input.community];
  for (const p of input.players) {
    if (ids.has(p.playerId)) throw new Error(`duplicate playerId: ${p.playerId}`);
    ids.add(p.playerId);
    if (p.hole.length !== 2) throw new Error(`player ${p.playerId} must have 2 hole cards`);
    cards.push(...p.hole);
    const { ante, blind, jackpot } = p.bets;
    for (const [k, v] of Object.entries(p.bets)) assertChip(v, `${p.playerId}.${k}`);
    if (ante <= 0) throw new Error(`${p.playerId}: ante must be positive`);
    if (ante !== blind) throw new Error(`${p.playerId}: ante and blind must be equal`);
    if (jackpot !== 0 && jackpot !== rules.jackpotBetAmount) {
      throw new Error(`${p.playerId}: jackpot bet must be 0 or ${rules.jackpotBetAmount}`);
    }
  }
  assertDistinctCards(cards);
}
