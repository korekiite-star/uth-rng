/**
 * 公開乱数ビーコン（drand quicknet）。
 *
 * 運営（サーバー）は全員のクライアントシードを配る前に知っているので、シードだけでは
 * 「サクラの席のシードを送り直して都合のいい山札を選ぶ」ことを防げない。
 * そこでディール時に参加者のシードを確定・公開してから、その時点ではまだ誰も知らない
 * drand の未来のラウンドの値を最後に混ぜる。
 *
 * drand quicknet: 3 秒ごとに新しい乱数を公開する分散型の公開乱数（League of Entropy。Cloudflare ほかが運営）。
 *   ラウンド r の公開時刻 = genesis + (r - 1) * period
 *   randomness = hex(SHA-256(signature))。signature は BLS 署名で、誰でも公開鍵で検証できる
 *   値は https://api.drand.sh/<chainHash>/public/<round> などで誰でも取得できる
 */
import { sha256, toHex } from './fair.js';

export const DRAND = {
  network: 'quicknet',
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  genesis: 1692803367,
  period: 3,
  /** 取得先（同じネットワークの値をどこから取っても同じ。1 つが落ちても他で取れる） */
  relays: ['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh', 'https://drand.cloudflare.com'],
} as const;

/** ディールで混ぜたビーコンの値 */
export interface BeaconValue {
  network: 'quicknet';
  round: number;
  randomness: string;
  signature: string;
}

/** ラウンド r が公開される時刻（ms） */
export function beaconRoundTime(round: number): number {
  return (DRAND.genesis + (round - 1) * DRAND.period) * 1000;
}

/**
 * シードを確定した時刻 now（ms）に対して使うラウンド。
 * 公開が now + marginMs 以降になる最初のラウンド（= 確定の時点ではまだ誰も値を知らない）
 */
export function beaconTargetRound(now: number, marginMs = 1000): number {
  const t = (now + marginMs) / 1000;
  return Math.max(1, Math.ceil((t - DRAND.genesis) / DRAND.period) + 1);
}

/** randomness が signature の SHA-256 になっているか（取得した値の形の確認） */
export function isBeaconConsistent(v: { randomness: string; signature: string }): boolean {
  if (!/^[0-9a-f]{64}$/.test(v.randomness) || !/^[0-9a-f]+$/.test(v.signature) || v.signature.length % 2) return false;
  const sig = new Uint8Array(v.signature.length / 2);
  for (let i = 0; i < sig.length; i++) sig[i] = parseInt(v.signature.slice(i * 2, i * 2 + 2), 16);
  return toHex(sha256(sig)) === v.randomness;
}

/** 公式の取得先 URL（検証ページのリンク用） */
export function beaconUrl(round: number, relay: string = DRAND.relays[0]): string {
  return `${relay}/${DRAND.chainHash}/public/${round}`;
}
