/**
 * カード表現・デッキ生成・シャッフル。
 * カードは "As"（スペードのA）, "Td"（ダイヤの10）のような 2 文字の文字列で表す。
 * JSON にそのまま載せられ、ログや DB でも可読なため。
 */

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
export const SUITS = ['s', 'h', 'd', 'c'] as const;

export type Rank = (typeof RANKS)[number];
export type Suit = (typeof SUITS)[number];
export type Card = `${Rank}${Suit}`;

const RANK_VALUE: Readonly<Record<string, number>> = Object.fromEntries(
  RANKS.map((r, i) => [r, i + 2]),
);

/** 2..14（A=14） */
export function rankValue(card: Card): number {
  return RANK_VALUE[card[0]!]!;
}

export function suitOf(card: Card): Suit {
  return card[1] as Suit;
}

export function isCard(x: unknown): x is Card {
  return (
    typeof x === 'string' &&
    x.length === 2 &&
    (RANKS as readonly string[]).includes(x[0]!) &&
    (SUITS as readonly string[]).includes(x[1]!)
  );
}

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(`${r}${s}`);
  return deck;
}

/** [0, maxExclusive) の一様乱数整数を返す関数 */
export type RandomInt = (maxExclusive: number) => number;

/**
 * CSPRNG（Web Crypto）による一様乱数。
 * Workers / ブラウザ / Node いずれでも globalThis.crypto が使える。
 * 剰余バイアスを避けるため棄却サンプリングを行う。
 */
export const cryptoRandomInt: RandomInt = (maxExclusive) => {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 2 ** 32) {
    throw new RangeError(`invalid maxExclusive: ${maxExclusive}`);
  }
  const limit = Math.floor(2 ** 32 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const v = buf[0]!;
    if (v < limit) return v % maxExclusive;
  }
};

/** Fisher–Yates。入力は破壊しない。 */
export function shuffle(cards: readonly Card[], randomInt: RandomInt = cryptoRandomInt): Card[] {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function assertDistinctCards(cards: readonly Card[]): void {
  const seen = new Set<string>();
  for (const c of cards) {
    if (!isCard(c)) throw new Error(`invalid card: ${String(c)}`);
    if (seen.has(c)) throw new Error(`duplicate card: ${c}`);
    seen.add(c);
  }
}
