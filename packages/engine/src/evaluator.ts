/**
 * ポーカー役判定。
 * - evaluate5: ちょうど 5 枚の役
 * - evaluateBest: 5〜7 枚から最強の 5 枚役（本戦は 7 枚、ジャックポットは 5 枚）
 *
 * score は「カテゴリ * 16^5 + タイブレーク順位（16進 5 桁）」の整数で、
 * 大きいほど強い。score が等しければ完全な引き分け。
 */
import { type Card, rankValue, suitOf } from './cards.js';

export enum HandCategory {
  HighCard = 0,
  OnePair = 1,
  TwoPair = 2,
  ThreeOfAKind = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  FourOfAKind = 7,
  StraightFlush = 8,
  RoyalFlush = 9,
}

export const CATEGORY_LABEL_JA: Readonly<Record<HandCategory, string>> = {
  [HandCategory.HighCard]: 'ハイカード',
  [HandCategory.OnePair]: 'ワンペア',
  [HandCategory.TwoPair]: 'ツーペア',
  [HandCategory.ThreeOfAKind]: 'スリーカード',
  [HandCategory.Straight]: 'ストレート',
  [HandCategory.Flush]: 'フラッシュ',
  [HandCategory.FullHouse]: 'フルハウス',
  [HandCategory.FourOfAKind]: 'フォーカード',
  [HandCategory.StraightFlush]: 'ストレートフラッシュ',
  [HandCategory.RoyalFlush]: 'ロイヤルフラッシュ',
};

export interface EvaluatedHand {
  category: HandCategory;
  score: number;
  /** 最強 5 枚。役を構成する札 → キッカーの順（表示用） */
  cards: Card[];
}

const CATEGORY_BASE = 16 ** 5;

export function evaluate5(cards: readonly Card[]): EvaluatedHand {
  if (cards.length !== 5) throw new Error(`evaluate5 needs 5 cards, got ${cards.length}`);

  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]!));

  const counts = new Map<number, number>();
  for (const c of cards) counts.set(rankValue(c), (counts.get(rankValue(c)) ?? 0) + 1);
  // [rank, count] を 枚数降順 → ランク降順
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  let straightHigh = 0;
  if (counts.size === 5) {
    const desc = [...counts.keys()].sort((a, b) => b - a);
    if (desc[0]! - desc[4]! === 4) straightHigh = desc[0]!;
    else if (desc[0] === 14 && desc[1] === 5) straightHigh = 5; // A-2-3-4-5（ホイール）
  }

  const c0 = groups[0]![1];
  const c1 = groups[1]?.[1] ?? 0;
  let category: HandCategory;
  if (straightHigh && flush) {
    category = straightHigh === 14 ? HandCategory.RoyalFlush : HandCategory.StraightFlush;
  } else if (c0 === 4) category = HandCategory.FourOfAKind;
  else if (c0 === 3 && c1 === 2) category = HandCategory.FullHouse;
  else if (flush) category = HandCategory.Flush;
  else if (straightHigh) category = HandCategory.Straight;
  else if (c0 === 3) category = HandCategory.ThreeOfAKind;
  else if (c0 === 2 && c1 === 2) category = HandCategory.TwoPair;
  else if (c0 === 2) category = HandCategory.OnePair;
  else category = HandCategory.HighCard;

  const tiebreak = straightHigh ? [straightHigh] : groups.map((g) => g[0]);
  let score = category * CATEGORY_BASE;
  tiebreak.forEach((r, i) => (score += r * 16 ** (4 - i)));

  const order = new Map(groups.map(([r], i) => [r, i]));
  const sorted = cards.slice().sort((a, b) => order.get(rankValue(a))! - order.get(rankValue(b))!);
  if (straightHigh === 5) sorted.push(sorted.shift()!); // ホイールは A を末尾に

  return { category, score, cards: sorted };
}

export function evaluateBest(cards: readonly Card[]): EvaluatedHand {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluateBest needs 5-7 cards, got ${cards.length}`);
  }
  let best: EvaluatedHand | undefined;
  for (const combo of combinations(cards, 5)) {
    const h = evaluate5(combo);
    if (!best || h.score > best.score) best = h;
  }
  return best!;
}

/** 正: a の勝ち / 負: b の勝ち / 0: 引き分け */
export function compareHands(a: EvaluatedHand, b: EvaluatedHand): number {
  return Math.sign(a.score - b.score);
}

function* combinations<T>(arr: readonly T[], k: number, start = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === k) {
    yield acc.slice();
    return;
  }
  for (let i = start; i <= arr.length - (k - acc.length); i++) {
    acc.push(arr[i]!);
    yield* combinations(arr, k, i + 1, acc);
    acc.pop();
  }
}
