/**
 * プルーブリーフェア: 自分のクライアントシード（ベット確定時にサーバーへ送る乱数）。
 * 後で「自分が送ったシードが本当に山札の計算に使われたか」を確かめられるよう、このブラウザに控えておく。
 */
import { newClientSeed } from '@uth/engine';

const KEY = 'uth.clientSeeds';
const KEEP = 200;

type Store = Record<string, string>; // "卓コード#ハンド番号" → シード

function load(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Store;
  } catch {
    return {};
  }
}

/** このハンドで送るシード（同じハンドで確定し直しても同じものを使う） */
export function clientSeedFor(room: string, handNo: number): string {
  const store = load();
  const key = `${room}#${handNo}`;
  if (store[key]) return store[key]!;
  const seed = newClientSeed();
  const entries = [...Object.entries(store), [key, seed] as const].slice(-KEEP);
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // 保存できなくてもシードは送る（控えがないだけ）
  }
  return seed;
}

/** 控えておいた自分のシード（なければ null） */
export function sentSeed(room: string, handNo: number): string | null {
  return load()[`${room}#${handNo}`] ?? null;
}
