/**
 * プレイヤーアクションの合法性とアクション履歴の解決。
 * サーバー（進行管理）とクライアント（ボタン活性制御）の両方で使う。
 */

export const STREETS = ['PREFLOP', 'FLOP', 'RIVER'] as const;
export type Street = (typeof STREETS)[number];

export type PlayerAction = 'PLAY_4X' | 'PLAY_3X' | 'PLAY_2X' | 'PLAY_1X' | 'CHECK' | 'FOLD';

export interface ActionRecord {
  street: Street;
  action: PlayerAction;
  /** タイムアウト・キック等でサーバーが代行した場合 true */
  auto?: boolean;
}

export const LEGAL_ACTIONS: Readonly<Record<Street, readonly PlayerAction[]>> = {
  PREFLOP: ['PLAY_4X', 'PLAY_3X', 'CHECK'],
  FLOP: ['PLAY_2X', 'CHECK'],
  RIVER: ['PLAY_1X', 'FOLD'],
};

/** タイムアウト時: チェックできればチェック、リバーはフォールド */
export const TIMEOUT_ACTION: Readonly<Record<Street, PlayerAction>> = {
  PREFLOP: 'CHECK',
  FLOP: 'CHECK',
  RIVER: 'FOLD',
};

export const PLAY_MULTIPLIER: Readonly<Partial<Record<PlayerAction, 4 | 3 | 2 | 1>>> = {
  PLAY_4X: 4,
  PLAY_3X: 3,
  PLAY_2X: 2,
  PLAY_1X: 1,
};

export type Decision =
  | { status: 'PENDING'; nextStreet: Street }
  | { status: 'PLAYED'; street: Street; multiplier: 4 | 3 | 2 | 1 }
  | { status: 'FOLDED' };

/**
 * アクション履歴を検証し、現在の決定状態を返す。不正な履歴は例外。
 * 履歴は PREFLOP → FLOP → RIVER の順に 1 件ずつで、PLAY / FOLD の後には何も続かない。
 */
export function resolveDecision(history: readonly ActionRecord[]): Decision {
  for (let i = 0; i < history.length; i++) {
    const { street, action } = history[i]!;
    const expected = STREETS[i];
    if (street !== expected) {
      throw new Error(`action #${i} must be on ${expected ?? '(none)'}, got ${street}`);
    }
    if (!LEGAL_ACTIONS[street].includes(action)) {
      throw new Error(`${action} is not legal on ${street}`);
    }
    const isLast = i === history.length - 1;
    const multiplier = PLAY_MULTIPLIER[action];
    if (multiplier || action === 'FOLD') {
      if (!isLast) throw new Error(`no action allowed after ${action}`);
      return multiplier ? { status: 'PLAYED', street, multiplier } : { status: 'FOLDED' };
    }
  }
  return { status: 'PENDING', nextStreet: STREETS[history.length]! };
}

/** そのストリートでアクションが必要か（= まだ Check を続けているか） */
export function needsActionOn(history: readonly ActionRecord[], street: Street): boolean {
  const d = resolveDecision(history);
  return d.status === 'PENDING' && d.nextStreet === street;
}
