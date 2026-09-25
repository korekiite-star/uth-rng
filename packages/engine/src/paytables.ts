/**
 * 配当テーブルとルール定数。
 * 配当はすべて「純増額」（賭け金は別途返却）で表す。端数は切り捨て（整数チップ）。
 */
import { HandCategory } from './evaluator.js';

/** win to per（例: 3 to 2 → { win: 3, per: 2 }） */
export interface Odds {
  win: number;
  per: number;
}

export function payOdds(stake: number, odds: Odds): number {
  return Math.floor((stake * odds.win) / odds.per);
}

/** Blind（ディーラーに勝利した時のみ適用。載っていない役はプッシュ） */
export const BLIND_PAYTABLE: Readonly<Partial<Record<HandCategory, Odds>>> = {
  [HandCategory.RoyalFlush]: { win: 500, per: 1 },
  [HandCategory.StraightFlush]: { win: 50, per: 1 },
  [HandCategory.FourOfAKind]: { win: 10, per: 1 },
  [HandCategory.FullHouse]: { win: 3, per: 1 },
  [HandCategory.Flush]: { win: 3, per: 2 },
  [HandCategory.Straight]: { win: 1, per: 1 },
};

/** Trips（勝敗・フォールド不問。載っていない役は没収） */
export const TRIPS_PAYTABLE: Readonly<Partial<Record<HandCategory, Odds>>> = {
  [HandCategory.RoyalFlush]: { win: 50, per: 1 },
  [HandCategory.StraightFlush]: { win: 40, per: 1 },
  [HandCategory.FourOfAKind]: { win: 30, per: 1 },
  [HandCategory.FullHouse]: { win: 8, per: 1 },
  [HandCategory.Flush]: { win: 7, per: 1 },
  [HandCategory.Straight]: { win: 4, per: 1 },
  [HandCategory.ThreeOfAKind]: { win: 3, per: 1 },
};

export type JackpotPrize =
  /** 抽選時点（当ハンドの積立後）のプール額に対する割合 */
  | { type: 'POOL_SHARE'; percent: number }
  | { type: 'FIXED'; amount: number };

/** ジャックポット（手札2枚＋フロップ3枚の 5 枚役） */
export const JACKPOT_PAYTABLE: Readonly<Partial<Record<HandCategory, JackpotPrize>>> = {
  [HandCategory.RoyalFlush]: { type: 'POOL_SHARE', percent: 100 },
  [HandCategory.StraightFlush]: { type: 'POOL_SHARE', percent: 10 },
  [HandCategory.FourOfAKind]: { type: 'FIXED', amount: 3000 },
  [HandCategory.FullHouse]: { type: 'FIXED', amount: 1000 },
  [HandCategory.Flush]: { type: 'FIXED', amount: 500 },
  [HandCategory.Straight]: { type: 'FIXED', amount: 300 },
};

/** エンビーボーナス（達成者以外の JP ベッター 1 人あたり） */
export const ENVY_BONUS: Readonly<Partial<Record<HandCategory, number>>> = {
  [HandCategory.RoyalFlush]: 1000,
  [HandCategory.StraightFlush]: 300,
};

export interface RuleConfig {
  /** JP ベット額（固定） */
  jackpotBetAmount: number;
  /** JP ベット 1 口あたりプールへ積み立てる額（残りはハウス＝ディーラー利益） */
  jackpotContribution: number;
  /** シードマネー（プールの最低保証額） */
  jackpotSeed: number;
  /**
   * ディーラーがノンクオリファイの時の Ante の扱い。
   * - 'ALWAYS': 勝敗に関わらずプッシュ（フォールド時は没収）。一般的なカジノルールで、本アプリの既定。
   * - 'PLAYER_WIN_ONLY': プレイヤー勝利時のみプッシュ、負けたら没収。
   */
  anteOnDealerNotQualified: 'PLAYER_WIN_ONLY' | 'ALWAYS';
}

export const DEFAULT_RULES: Readonly<RuleConfig> = {
  jackpotBetAmount: 100,
  jackpotContribution: 90,
  jackpotSeed: 10_000,
  anteOnDealerNotQualified: 'ALWAYS',
};

/** Ante + Blind + 最大の Play（4x） */
export const MAX_ANTE_EXPOSURE_MULTIPLIER = 6;

/**
 * そのベットでハンドに参加するのに必要な残高。
 * Play 4x まで必ず払えるように Ante×6 + Trips + JP を要求する。
 */
export function requiredBalance(bets: { ante: number; trips: number; jackpot: number }): number {
  return bets.ante * MAX_ANTE_EXPOSURE_MULTIPLIER + bets.trips + bets.jackpot;
}
