/**
 * 公正性レポート: 本番と同じ山札の作り方（プルーブリーフェア）で N ハンド配り、統計で偏りを調べる。
 *
 *   npm run fairness -- commit                               # マスターシードを作ってコミットだけ表示（友人に先に渡す）
 *   npm run fairness -- run --client-seed <友人の文字列>      # 直前に作ったマスターシードで N ハンド配ってレポート作成
 *   npm run fairness -- run --client-seed demo --new          # マスターシードを新しく作ってすぐ配る（お試し用）
 *   オプション: --hands 100000
 *
 * 各ハンドの山札（検算方法は packages/engine/src/fair.ts / apps/web/public/verify_hand.py と同じ）:
 *   serverSeed_i = hex(HMAC-SHA256(masterSeed, "hand:<i>"))
 *   clientSeeds  = { "player": <client seed> }、order = ["player"]、handNo = i
 *   → 1 人参加のハンドとして プレイヤー 2 枚 → ディーラー 2 枚 → ボード 5 枚
 *
 * 出力（reports/fairness/<日時>/）:
 *   hands.csv    全ハンドの履歴（各行の server_seed で 1 ハンドずつ検算できる）
 *   summary.json 集計結果
 *   report.html  レポート
 *   master.json  マスターシード・コミット・クライアントシード（レポート公開後に渡す）
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Card,
  HandCategory,
  commitOf,
  compareHands,
  createDeck,
  dealFromDeck,
  evaluateBest,
  fairDeck,
  hmacSha256,
  newServerSeed,
  toHex,
} from '../../packages/engine/src/index.js';
import { renderReport } from './render.js';

const args = process.argv.slice(2);
const mode = args[0];
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const ROOT = join(process.cwd(), 'reports', 'fairness');
const PENDING = join(ROOT, 'pending-master.json');
const enc = (s: string) => new TextEncoder().encode(s);

// ------------------------------------------------------------------ commit: マスターシードを作って封印

if (mode === 'commit') {
  mkdirSync(ROOT, { recursive: true });
  const masterSeed = newServerSeed();
  const commit = commitOf(masterSeed);
  writeFileSync(PENDING, JSON.stringify({ masterSeed, commit, createdAt: new Date().toISOString() }, null, 2));
  console.log('マスターシードを作りました（reports/fairness/pending-master.json。レポート公開まで誰にも見せない）');
  console.log(`\nコミット（先に友人へ渡す）:\n  ${commit}\n`);
  console.log('友人から好きな文字列（クライアントシード）をもらったら:\n  npm run fairness -- run --client-seed <その文字列>');
  process.exit(0);
}

if (mode !== 'run') {
  console.log('使い方: npm run fairness -- commit | run --client-seed <文字列> [--hands 100000] [--new]');
  process.exit(1);
}

const clientSeed = opt('client-seed');
if (!clientSeed) throw new Error('--client-seed が必要です');
const N = Number(opt('hands') ?? 100_000);
let master: { masterSeed: string; commit: string; createdAt: string };
if (args.includes('--new') || !existsSync(PENDING)) {
  const masterSeed = newServerSeed();
  master = { masterSeed, commit: commitOf(masterSeed), createdAt: new Date().toISOString() };
  console.log('（お試し: マスターシードを新しく作りました。コミットは事前に渡していません）');
} else {
  master = JSON.parse(readFileSync(PENDING, 'utf8'));
}
const preCommitted = !args.includes('--new') && existsSync(PENDING);

// ------------------------------------------------------------------ 配る・集計

const CATS = [
  HandCategory.HighCard,
  HandCategory.OnePair,
  HandCategory.TwoPair,
  HandCategory.ThreeOfAKind,
  HandCategory.Straight,
  HandCategory.Flush,
  HandCategory.FullHouse,
  HandCategory.FourOfAKind,
  HandCategory.StraightFlush,
  HandCategory.RoyalFlush,
];
const CAT_JA = ['ハイカード', 'ワンペア', 'ツーペア', 'スリーカード', 'ストレート', 'フラッシュ', 'フルハウス', 'フォーカード', 'ストレートフラッシュ', 'ロイヤルフラッシュ'];
// 7 枚から最良 5 枚の役の組み合わせ数（全 133,784,560 通り）
const P7 = [23_294_460, 58_627_800, 31_433_400, 6_461_620, 6_180_020, 4_047_644, 3_473_184, 224_848, 37_260, 4_324].map((x) => x / 133_784_560);
// 5 枚の役の組み合わせ数（全 2,598,960 通り）… JP は手札 2 枚 + フロップ 3 枚の 5 枚役
const P5 = [1_302_540, 1_098_240, 123_552, 54_912, 10_200, 5_108, 3_744, 624, 36, 4].map((x) => x / 2_598_960);

const DECK = createDeck();
const POSITIONS = 9; // プレイヤー 2 + ディーラー 2 + ボード 5
const posCount = Array.from({ length: POSITIONS }, () => new Map<Card, number>(DECK.map((c) => [c, 0])));
const playerCat = new Array(10).fill(0);
const dealerCat = new Array(10).fill(0);
const jpCat = new Array(10).fill(0);
let pairs = 0;
let suited = 0;
let win = 0;
let lose = 0;
let tie = 0;
let dealerQualified = 0;
let sameFirstAsPrev = 0;
let prevFirst: Card | null = null;

const csv: string[] = ['hand,server_seed,player,dealer,board,player_hand,dealer_hand,jp_hand,showdown'];
const t0 = Date.now();
const key = enc(master.masterSeed);

for (let i = 1; i <= N; i++) {
  const serverSeed = toHex(hmacSha256(key, enc(`hand:${i}`)));
  const deck = fairDeck(serverSeed, `player:${clientSeed}`, i);
  const { holes, dealer, community } = dealFromDeck(deck, ['player']);
  const hole = holes['player']!;
  const dealt = [...hole, ...dealer, ...community];
  dealt.forEach((c, p) => posCount[p]!.set(c, posCount[p]!.get(c)! + 1));

  if (hole[0]![0] === hole[1]![0]) pairs++;
  else if (hole[0]![1] === hole[1]![1]) suited++;
  if (prevFirst === hole[0]) sameFirstAsPrev++;
  prevFirst = hole[0]!;

  const ph = evaluateBest([...hole, ...community]);
  const dh = evaluateBest([...dealer, ...community]);
  const jh = evaluateBest([...hole, ...community.slice(0, 3)]);
  playerCat[ph.category]++;
  dealerCat[dh.category]++;
  jpCat[jh.category]++;
  if (dh.category >= HandCategory.OnePair) dealerQualified++;
  const cmp = compareHands(ph, dh);
  if (cmp > 0) win++;
  else if (cmp < 0) lose++;
  else tie++;

  csv.push(
    [i, serverSeed, hole.join(' '), dealer.join(' '), community.join(' '), CAT_JA[ph.category], CAT_JA[dh.category], CAT_JA[jh.category], cmp > 0 ? 'プレイヤー' : cmp < 0 ? 'ディーラー' : '引き分け'].join(','),
  );
  if (i % 20_000 === 0) console.log(`  ${i.toLocaleString()} / ${N.toLocaleString()} ハンド`);
}
const seconds = (Date.now() - t0) / 1000;

// ------------------------------------------------------------------ 統計

/** 正則化上側不完全ガンマ関数 Q(a, x)（カイ二乗の p 値 = Q(df/2, χ²/2)） */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const lg = logGamma(a);
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 1000; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lg);
  }
  let b = x + 1 - a;
  let c = 1e300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - lg) * h;
}
function logGamma(z: number): number {
  const g = 7;
  const p = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = p[0]!;
  for (let i = 1; i < g + 2; i++) x += p[i]! / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
const chiP = (chi: number, df: number) => gammaQ(df / 2, chi / 2);
/** 正規分布の両側 p 値 = erfc(|z| / √2) */
const normP = (z: number) => {
  // erfc の近似（Numerical Recipes の erfcc。相対誤差 1.2e-7 未満）
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * x);
  const r = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return r;
};

function categoryTest(obs: number[], probs: number[]) {
  // 期待度数が小さいロイヤルはストレートフラッシュとまとめて検定する
  const o = [...obs.slice(0, 8), obs[8]! + obs[9]!];
  const p = [...probs.slice(0, 8), probs[8]! + probs[9]!];
  const chi = o.reduce((s, x, i) => s + (x - N * p[i]!) ** 2 / (N * p[i]!), 0);
  const df = o.length - 1;
  return {
    rows: CATS.map((c) => ({ name: CAT_JA[c]!, observed: obs[c]!, expected: N * probs[c]!, rate: obs[c]! / N, expectedRate: probs[c]! })),
    chi,
    df,
    p: chiP(chi, df),
  };
}

const positions = posCount.map((m, i) => {
  const exp = N / 52;
  const chi = [...m.values()].reduce((s, x) => s + (x - exp) ** 2 / exp, 0);
  return { position: i, label: ['プレイヤー 1 枚目', 'プレイヤー 2 枚目', 'ディーラー 1 枚目', 'ディーラー 2 枚目', 'フロップ 1', 'フロップ 2', 'フロップ 3', 'ターン', 'リバー'][i]!, chi, df: 51, p: chiP(chi, 51), min: Math.min(...m.values()), max: Math.max(...m.values()) };
});
const totalCard = DECK.map((c) => ({ card: c, count: posCount.reduce((s, m) => s + m.get(c)!, 0) }));
const totalExp = (N * POSITIONS) / 52;
const totalChi = totalCard.reduce((s, x) => s + (x.count - totalExp) ** 2 / totalExp, 0);

const showdownZ = (win - lose) / Math.sqrt(win + lose);
const qualExp = 1 - P7[0]!;
const qualZ = (dealerQualified - N * qualExp) / Math.sqrt(N * qualExp * (1 - qualExp));
const serialExp = 1 / 52;
const serialZ = (sameFirstAsPrev - (N - 1) * serialExp) / Math.sqrt((N - 1) * serialExp * (1 - serialExp));
const pairExp = 3 / 51;
const suitedExp = 12 / 51;
const startChi =
  (pairs - N * pairExp) ** 2 / (N * pairExp) +
  (suited - N * suitedExp) ** 2 / (N * suitedExp) +
  (N - pairs - suited - N * (1 - pairExp - suitedExp)) ** 2 / (N * (1 - pairExp - suitedExp));

export type Summary = typeof summary;
const summary = {
  hands: N,
  seconds,
  master: { commit: master.commit, preCommitted, createdAt: master.createdAt },
  clientSeed,
  positions,
  allCards: { chi: totalChi, df: 51, p: chiP(totalChi, 51), min: Math.min(...totalCard.map((x) => x.count)), max: Math.max(...totalCard.map((x) => x.count)), expected: totalExp, cards: totalCard },
  starting: { pairs, suited, offsuit: N - pairs - suited, pairExp, suitedExp, chi: startChi, df: 2, p: chiP(startChi, 2) },
  player7: categoryTest(playerCat, P7),
  dealer7: categoryTest(dealerCat, P7),
  jp5: categoryTest(jpCat, P5),
  showdown: { win, lose, tie, z: showdownZ, p: normP(showdownZ) },
  dealerQualify: { count: dealerQualified, rate: dealerQualified / N, expected: qualExp, z: qualZ, p: normP(qualZ) },
  serial: { count: sameFirstAsPrev, rate: sameFirstAsPrev / (N - 1), expected: serialExp, z: serialZ, p: normP(serialZ) },
};

// ------------------------------------------------------------------ 出力

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const out = join(ROOT, stamp);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'hands.csv'), '﻿' + csv.join('\n'), 'utf8');
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
writeFileSync(join(out, 'master.json'), JSON.stringify({ ...master, clientSeed, hands: N, preCommitted }, null, 2));
writeFileSync(join(out, 'report.html'), renderReport(summary));
// 使ったマスターシードは使い回さない（別のクライアントシードで何度も試して都合のいい結果を選べないように）
if (preCommitted) unlinkSync(PENDING);
console.log(`\n${N.toLocaleString()} ハンド（${seconds.toFixed(1)} 秒）→ ${out}`);
