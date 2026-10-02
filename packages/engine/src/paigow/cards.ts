/**
 * パイガオのカード: 通常の 52 枚 + ジョーカー 1 枚（'Jk'）の 53 枚。
 * UTH・ドラマハの Card 型は変えず、ジョーカーだけ別の値として足す。
 */
import { type Card, type RandomInt, createDeck, cryptoRandomInt, isCard, rankValue, shuffle, suitOf } from '../cards.js';
import { fairRandom } from '../fair.js';

export const JOKER = 'Jk' as const;
export type PgCard = Card | typeof JOKER;

export const isJoker = (c: PgCard): c is typeof JOKER => c === JOKER;

export function isPgCard(x: unknown): x is PgCard {
  return x === JOKER || isCard(x);
}

/** 初期順: 2s 3s … As 2h … Ac（UTH と同じ 52 枚）の最後にジョーカー */
export function createDeck53(): PgCard[] {
  return [...createDeck(), JOKER];
}

/**
 * 公正性の山札（53 枚版）。UTH の fairDeck と同じ乱数列（HMAC-SHA256・棄却サンプリング）で、
 * 初期順 createDeck53() を Fisher–Yates（i = 52 → 1）で混ぜる
 */
export function fairDeck53(serverSeed: string, mix: string, handNo: number): PgCard[] {
  return shuffle53(createDeck53(), fairRandom(serverSeed, mix, handNo));
}

export function shuffle53(cards: readonly PgCard[], randomInt: RandomInt = cryptoRandomInt): PgCard[] {
  // shuffle は Card[] 用だが、中身の型は見ないのでそのまま使える
  return shuffle(cards as Card[], randomInt) as PgCard[];
}

/** 山札の先頭から、order の順に 7 枚ずつ */
export function dealSevens(deck: readonly PgCard[], order: readonly string[]): Record<string, PgCard[]> {
  const out: Record<string, PgCard[]> = {};
  order.forEach((id, i) => (out[id] = deck.slice(i * 7, i * 7 + 7)));
  return out;
}

/** ジョーカーは A（14）として数える */
export const pgRank = (c: PgCard): number => (isJoker(c) ? 14 : rankValue(c));
export const pgSuit = (c: PgCard) => (isJoker(c) ? null : suitOf(c));
