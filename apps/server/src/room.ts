/**
 * 卓の進行ロジック（Durable Object から切り離した純粋なモジュール）。
 * apply() は状態を複製してからコマンドを適用するので、途中で RoomError が投げられても元の状態は壊れない。
 */
import {
  type ActionRecord,
  type Card,
  type FairRecord,
  type JackpotResult,
  type PlayerBets,
  type Street,
  DEFAULT_RULES,
  LEGAL_ACTIONS,
  TIMEOUT_ACTION,
  combineClientSeeds,
  commitOf,
  dealFromDeck,
  fairDeck,
  isValidClientSeed,
  needsActionOn,
  newServerSeed,
  requiredBalance,
  resolveDecision,
  settleHand,
  settleJackpot,
} from '@uth/engine';
import type {
  BalanceWarning,
  BetRequest,
  C2S,
  DealerControls,
  ErrorCode,
  HandHistoryEntry,
  LobbyRoom,
  LogEntry,
  MyHandEntry,
  Phase,
  PublicSeat,
  RoomConfig,
  RoomView,
  SeatStatus,
  SessionSummary,
  ShowdownView,
} from '@uth/protocol';

export class RoomError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const DEFAULT_CONFIG: RoomConfig = {
  minAnte: 100,
  maxAnte: 2000,
  maxTrips: 500,
  betSeconds: 60,
  actionSeconds: 60,
  resultSeconds: 15,
  maxSeats: 7,
};

export const STARTING_BALANCE = 10_000;
export const MAX_ADDON = 1_000_000;
const LOG_LIMIT = 40;
const HISTORY_LIMIT = 30;

export interface SeatState {
  userId: string;
  name: string;
  seat: number;
  /** 確定済み残高（ハンド中のベットはまだ引かれていない） */
  balance: number;
  addonTotal: number;
  sessionNet: number;
  preset: BetRequest | null;
  kicked: boolean;
  leaving: boolean;
  /** 離席中（席は残したまま、毎ハンド自動で見送り） */
  away?: boolean;
  /** 集計用のアカウント（ログインのメールアドレス。開発用 ID ならその ID） */
  account?: string;
  /** この卓で参加したハンドの記録（古い順、最大 HISTORY_LIMIT 件） */
  hands?: MyHandEntry[];
  /** デモ卓の Bot（卓の中で自動で動く） */
  bot?: boolean;
}

/** デモ卓の Bot の名前（空いている名前から順に使う） */
export const BOT_NAMES = ['さくら', 'ケン', 'ミホ', 'ジョー', 'リナ', 'タク', 'ユイ'];

export interface HandPlayer {
  userId: string;
  status: 'BETTING' | 'CONFIRMED' | 'SITTING_OUT';
  bets: PlayerBets;
  hole: Card[];
  actions: ActionRecord[];
}

export interface HandState {
  handNo: number;
  startedAt: number;
  deck: Card[];
  dealerHole: Card[];
  community: Card[];
  revealed: 0 | 3 | 5;
  /** ショーダウンでディーラーがめくった枚数 */
  dealerRevealed?: 0 | 1 | 2;
  players: HandPlayer[];
  pending: string[];
  deadline: number | null;
  jackpot: JackpotResult | null;
  /**
   * プルーブリーフェア: serverSeed は精算まで秘密（コミットだけ公開）。
   * clientSeeds はベット確定した人のもの、order はディール時に確定する配る順
   */
  fair?: { serverSeed: string; commit: string; clientSeeds: Record<string, string>; order?: string[] };
}

export interface RoomState {
  v: 1;
  roomCode: string;
  dealerId: string;
  dealerName: string;
  dealerAccount?: string;
  createdAt: number;
  seq: number;
  phase: Phase;
  handNo: number;
  config: RoomConfig;
  seats: SeatState[];
  banned: string[];
  jackpotPool: number;
  /** セッション開始時の JP プール（ディーラー収支に JP を含める集計の基準） */
  poolAtStart?: number;
  dealerSessionNet: number;
  handsPlayed: number;
  hand: HandState | null;
  lastResult: ShowdownView | null;
  /** 直近のハンドの収支記録（古い順、最大 HISTORY_LIMIT 件） */
  history?: HandHistoryEntry[];
  /** ショーダウン結果の表示終了時刻。これまで次のハンドは開始できない */
  resultUntil?: number | null;
  /** ハンド中にディーラーの接続が全部切れた時刻（戻れば null） */
  dealerGoneAt?: number | null;
  /** 最後に誰かが操作した時刻（放置された卓の自動解散に使う） */
  lastActiveAt?: number;
  /**
   * デモ卓（練習用）。何も保存しない: スプシ・D1 に書かない、財布の残高を使わず全員 STARTING_BALANCE から、
   * JP プールもディーラーの本物のプールとは別（シード額から始まり、解散で消える）
   */
  demo?: boolean;
  /** デモ卓を作った人（ディーラー ⇔ プレイヤーを切り替えられる。プレイヤーの間は Bot がディーラー） */
  demoOwner?: string;
  /** 途中で退席した人のこの卓での収支（ゲーム終了時の収支一覧に含める） */
  departed?: { userId: string; name: string; net: number; addon: number; balance: number }[];
  log: LogEntry[];
  closed: boolean;
  /**
   * まだ外部（D1 / スプレッドシート）に書けていない記録。
   * 状態と一緒に保存されるので、書き込みに失敗しても次の機会に再送できる
   */
  outbox?: PersistJob[];
}

/** 精算済みハンド・アドオンの保存用レコード */
export type PersistJob = (
  | {
      kind: 'HAND';
      /** 冪等キー "<sessionId>#<handNo>" */
      id: string;
      handNo: number;
      dealer: {
        id: string;
        name: string;
        account: string;
        hole: Card[];
        category: number;
        qualified: boolean;
        /** JP プール増減込み（= −Σ プレイヤー収支） */
        net: number;
        /** JP 除く */
        netTable: number;
      };
      community: Card[];
      pool: { before: number; after: number };
      fair?: FairRecord;
      players: {
        id: string;
        name: string;
        account: string;
        hole: Card[];
        outcome: 'WIN' | 'LOSE' | 'TIE' | 'FOLD';
        category: number | null;
        lines: { ante: number; blind: number; play: number; trips: number; jackpot: number };
        jpPrize: number;
        net: number;
      }[];
    }
  | { kind: 'ADDON'; id: string; user: { id: string; name: string; account: string }; amount: number }
) & {
  sessionId: string;
  roomCode: string;
  at: number;
  /** 書き込み済みの宛先 */
  done: { db?: boolean; sheet?: boolean };
  tries?: number;
};

const OUTBOX_LIMIT = 1000;

function enqueue(s: RoomState, job: PersistJob): void {
  if (s.demo) return; // デモ卓は何も保存しない
  s.outbox = [...(s.outbox ?? []), job].slice(-OUTBOX_LIMIT);
}

/** 誰も操作しないままこの時間が過ぎた卓（ハンドの合間）は自動で解散する */
export const IDLE_CLOSE_MS = 24 * 60 * 60 * 1000;

/** 放置で自動解散する時刻（ハンド中は対象外。ハンドは締切・ディーラー不在の無効化で必ず合間に戻る） */
export function idleCloseAt(s: RoomState): number | null {
  return s.phase === 'WAITING' && !s.closed ? (s.lastActiveAt ?? s.createdAt) + IDLE_CLOSE_MS : null;
}

/** ハンド中にディーラーがこの時間戻らなければ、ハンドを無効にして全額返金 */
export const DEALER_VOID_MS = 3 * 60 * 1000;

/** ディーラー不在でハンドが無効になる時刻（該当しなければ null） */
export function dealerVoidAt(s: RoomState): number | null {
  return s.dealerGoneAt && s.phase !== 'WAITING' ? s.dealerGoneAt + DEALER_VOID_MS : null;
}

/** クライアントからのコマンド + サーバー内部のコマンド */
export type Command =
  | C2S
  /**
   * balance: D1 に保存されている財布の残高（新しく着席する時・ハンドの合間の再接続時に反映）
   * watch: 観戦（着席していなければ席に着かずに見るだけ。着席済みならそのまま）
   */
  | { t: 'JOIN'; name: string; balance?: number; account?: string; watch?: boolean }
  | { t: 'TIMEOUT' }
  /** サーバー内部: ディーラーの接続が全部切れた / 戻った */
  | { t: 'DEALER_PRESENCE'; connected: boolean };

export interface Ctx {
  userId: string;
  now: number;
  /** テスト用: サーバーシードを固定する（本番は毎ハンド暗号乱数で作る） */
  serverSeed?: () => string;
}

/** 保存用の卓 ID（同じ卓コードが後で再利用されても区別できるよう作成時刻を付ける） */
export function sessionId(s: Pick<RoomState, 'roomCode' | 'createdAt'>): string {
  return `${s.roomCode}:${s.createdAt}`;
}

export function createRoom(
  roomCode: string,
  dealerId: string,
  dealerName: string,
  now: number,
  opts: { jackpotPool?: number; dealerAccount?: string; demo?: boolean } = {},
): RoomState {
  // ディーラーの JP プールは卓をまたいで持ち越す（前回の卓の続きから）
  const pool = opts.jackpotPool ?? DEFAULT_RULES.jackpotSeed;
  return {
    v: 1,
    roomCode,
    dealerId,
    dealerName,
    dealerAccount: opts.dealerAccount,
    demo: opts.demo || undefined,
    demoOwner: opts.demo ? dealerId : undefined,
    createdAt: now,
    seq: 0,
    phase: 'WAITING',
    handNo: 0,
    config: { ...DEFAULT_CONFIG },
    seats: [],
    banned: [],
    jackpotPool: pool,
    poolAtStart: pool,
    dealerSessionNet: 0,
    handsPlayed: 0,
    hand: null,
    lastResult: null,
    log: [{ at: now, text: `${dealerName} が${opts.demo ? 'デモ卓（記録されません）' : '卓'} ${roomCode} を作成しました` }],
    closed: false,
  };
}

export function apply(state: RoomState, ctx: Ctx, cmd: Command): RoomState {
  const s = structuredClone(state);
  handle(s, ctx, cmd);
  s.seq++;
  return s;
}

// ================================================================== コマンド処理

function handle(s: RoomState, ctx: Ctx, cmd: Command): void {
  const { userId, now } = ctx;
  // 古いバージョンで作られた卓の設定に新しい項目を補う
  s.config = { ...DEFAULT_CONFIG, ...s.config };
  if (s.closed) throw new RoomError('ROOM_CLOSED', 'この卓は解散しました');
  // 人の操作・接続だけを「活動」として数える（タイマーや接続切れは数えない）
  if (cmd.t !== 'TIMEOUT' && cmd.t !== 'DEALER_PRESENCE' && cmd.t !== 'PING' && cmd.t !== 'RESYNC') s.lastActiveAt = now;

  switch (cmd.t) {
    case 'JOIN':
      return join(s, userId, cmd, now);
    case 'TIMEOUT':
      return timeout(s, now);
    case 'DEALER_PRESENCE':
      if (cmd.connected) s.dealerGoneAt = null;
      else if (s.phase !== 'WAITING' && !s.dealerGoneAt) {
        s.dealerGoneAt = now;
        log(s, now, `ディーラーの接続が切れました（${DEALER_VOID_MS / 60000} 分戻らなければハンドを無効にして全額返金）`);
      }
      return;

    case 'PLACE_BET': {
      const { seat, hp } = bettingPlayer(s, userId, cmd.handNo);
      const bet = validateBet(s, seat, cmd.bet);
      hp.status = 'CONFIRMED';
      hp.bets = { ante: bet.ante, blind: bet.ante, trips: bet.trips, jackpot: bet.jackpot ? DEFAULT_RULES.jackpotBetAmount : 0 };
      seat.preset = bet;
      // 山札の計算に混ぜる（送られなければ、その人の分は混ぜない）
      const fair = s.hand!.fair;
      if (fair) {
        if (isValidClientSeed(cmd.clientSeed)) fair.clientSeeds[userId] = cmd.clientSeed;
        else delete fair.clientSeeds[userId];
      }
      return;
    }
    case 'CANCEL_BET': {
      const { hp } = bettingPlayer(s, userId, cmd.handNo);
      hp.status = 'BETTING';
      hp.bets = zeroBets();
      if (s.hand!.fair) delete s.hand!.fair.clientSeeds[userId];
      return;
    }
    case 'SIT_OUT': {
      const { seat, hp } = bettingPlayer(s, userId, cmd.handNo);
      hp.status = 'SITTING_OUT';
      hp.bets = zeroBets();
      if (s.hand!.fair) delete s.hand!.fair.clientSeeds[userId];
      log(s, now, `${seat.name} はこのハンドを見送り`);
      return;
    }

    case 'ACT': {
      const seat = requireSeat(s, userId);
      const hand = s.hand;
      const street = phaseStreet(s.phase);
      if (!hand || !street) throw new RoomError('BAD_PHASE', 'アクションできるタイミングではありません');
      if (cmd.handNo !== hand.handNo || cmd.street !== street) throw new RoomError('STALE', '画面が古くなっています');
      if (!hand.pending.includes(userId)) throw new RoomError('NOT_YOUR_TURN', 'アクション済みか、対象外です');
      if (!LEGAL_ACTIONS[street].includes(cmd.action)) throw new RoomError('ILLEGAL_ACTION', `${cmd.action} はできません`);
      const hp = hand.players.find((p) => p.userId === userId)!;
      recordAction(s, hand, hp, { street, action: cmd.action }, seat.name, now);
      return;
    }

    case 'SET_AWAY': {
      const seat = requireSeat(s, userId);
      seat.away = !!cmd.away;
      // ベット受付中なら、このハンドにもすぐ反映する（ハンド中なら次のハンドから）
      const hp = s.phase === 'BETTING' ? s.hand?.players.find((p) => p.userId === userId) : undefined;
      if (hp && seat.away && hp.status === 'BETTING') hp.status = 'SITTING_OUT';
      if (hp && !seat.away && hp.status === 'SITTING_OUT') hp.status = 'BETTING';
      log(s, now, seat.away ? `${seat.name} が離席しました` : `${seat.name} が戻りました`);
      return;
    }

    case 'ADDON': {
      // いつでも追加できる（ベットは精算まで残高から引かないので、ハンド中に増やしても精算は変わらない）
      const seat = requireSeat(s, userId);
      if (!Number.isSafeInteger(cmd.amount) || cmd.amount < 1 || cmd.amount > MAX_ADDON) {
        throw new RoomError('BAD_REQUEST', `アドオン額は 1〜${MAX_ADDON.toLocaleString()} です`);
      }
      seat.balance += cmd.amount;
      seat.addonTotal += cmd.amount;
      enqueue(s, {
        kind: 'ADDON',
        id: `addon:${sessionId(s)}:${s.seq}`,
        user: { id: userId, name: seat.name, account: seat.account ?? userId },
        amount: cmd.amount,
        sessionId: sessionId(s),
        roomCode: s.roomCode,
        at: now,
        done: {},
      });
      log(s, now, `${seat.name} が ${cmd.amount.toLocaleString()} をアドオン`);
      return;
    }

    case 'LEAVE': {
      const seat = requireSeat(s, userId);
      if (inDealtHand(s, userId)) {
        seat.leaving = true;
        log(s, now, `${seat.name} はこのハンド終了後に退席します`);
      } else {
        removeSeat(s, userId);
        log(s, now, `${seat.name} が退席しました`);
      }
      return;
    }

    case 'DEALER_ADVANCE':
      requireDealer(s, userId);
      if (cmd.from !== s.phase || cmd.handNo !== s.handNo) throw new RoomError('STALE', '画面が古くなっています');
      {
        const lock = lockState(s, now);
        if (!lock.canAdvance) throw new RoomError('LOCKED', lock.lockReason ?? '進行できません');
      }
      return advance(s, ctx);

    case 'DEALER_SET_CONFIG':
      requireDealer(s, userId);
      if (s.phase !== 'WAITING') throw new RoomError('BAD_PHASE', '設定はハンドの合間のみ変更できます');
      {
        const next = validateConfig({ ...s.config, ...cmd.config });
        if (next.maxSeats < s.seats.length) {
          throw new RoomError('BAD_REQUEST', `いま ${s.seats.length} 人が着席しているため、席数を ${next.maxSeats} にはできません`);
        }
        s.config = next;
      }
      log(
        s,
        now,
        `卓設定を変更: 席数 ${s.config.maxSeats} / アンティ ${s.config.minAnte}〜${s.config.maxAnte} / トリップス上限 ${s.config.maxTrips}`,
      );
      return;

    case 'DEALER_KICK': {
      requireDealer(s, userId);
      const seat = s.seats.find((x) => x.userId === cmd.userId);
      if (!seat) throw new RoomError('BAD_REQUEST', 'そのプレイヤーは着席していません');
      s.banned.push(seat.userId);
      if (inDealtHand(s, seat.userId)) {
        // 途中のハンドは自動アクション（Check → Fold）で最後まで精算し、その後に退席させる
        seat.kicked = true;
        autoActKicked(s, now);
      } else {
        removeSeat(s, seat.userId);
      }
      log(s, now, `${seat.name} がキックされました`);
      return;
    }

    case 'DEALER_ADD_BOT': {
      if (!s.demo) throw new RoomError('BAD_REQUEST', 'Bot はデモ卓でだけ追加できます');
      if (userId !== s.demoOwner) requireDealer(s, userId);
      if (s.seats.length >= s.config.maxSeats) throw new RoomError('ROOM_FULL', '満席です');
      const used = new Set(s.seats.filter((x) => x.bot).map((x) => x.name));
      const base = BOT_NAMES.find((n) => !used.has(`🤖 ${n}`)) ?? `Bot${s.seq}`;
      const botId = `bot:${s.roomCode}:${s.seq}`;
      join(s, botId, { t: 'JOIN', name: `🤖 ${base}` }, now);
      s.seats.find((x) => x.userId === botId)!.bot = true;
      return;
    }

    case 'DEALER_CLOSE_ROOM':
      requireDealer(s, userId);
      if (s.phase !== 'WAITING') throw new RoomError('BAD_PHASE', 'ハンドの合間のみ解散できます');
      s.closed = true;
      log(s, now, '卓が解散されました');
      return;

    case 'DEMO_SWITCH_ROLE': {
      if (!s.demo || userId !== s.demoOwner) throw new RoomError('BAD_REQUEST', '切り替えはデモ卓を作った人だけができます');
      if (s.phase !== 'WAITING' && s.phase !== 'BETTING') throw new RoomError('BAD_PHASE', 'ハンドの合間かベット受付中に切り替えてください');
      if (userId === s.dealerId) {
        // ディーラー → プレイヤー（ディーラーは Bot が引き継ぐ）。残高は前に座っていたときの続きから
        const name = s.dealerName;
        const last = [...(s.departed ?? [])].reverse().find((d) => d.userId === userId);
        s.dealerId = demoDealerId(s);
        s.dealerName = '🤖 Dealer';
        s.dealerGoneAt = null;
        try {
          join(s, userId, { t: 'JOIN', name, balance: last?.balance }, now);
        } catch (e) {
          s.dealerId = userId;
          s.dealerName = name;
          throw e;
        }
        log(s, now, `${name} がプレイヤーになりました（ディーラーは Bot）`);
      } else {
        // プレイヤー → ディーラー
        const seat = requireSeat(s, userId);
        const hp = s.hand?.players.find((p) => p.userId === userId);
        if (hp?.status === 'CONFIRMED') throw new RoomError('BAD_PHASE', 'ベットを取り消してから切り替えてください');
        removeSeat(s, userId);
        s.dealerId = userId;
        s.dealerName = seat.name;
        s.dealerGoneAt = null;
        log(s, now, `${seat.name} がディーラーに戻りました`);
      }
      return;
    }

    case 'TAKE_SEAT':
      // DO が保存済みの残高を読み込んでから JOIN に変換して渡す
      throw new RoomError('BAD_REQUEST', '着席は JOIN で処理されます');

    case 'STAMP':
      // スタンプは状態を変えないので DO が直接全員に配る
      throw new RoomError('BAD_REQUEST', 'スタンプは卓の状態を変えません');

    case 'PING':
    case 'RESYNC':
      return;
  }
}

function join(s: RoomState, userId: string, cmd: Extract<Command, { t: 'JOIN' }>, now: number): void {
  const clean = sanitizeName(cmd.name);
  const balance = Number.isSafeInteger(cmd.balance) ? cmd.balance! : STARTING_BALANCE;
  if (userId === s.dealerId) {
    s.dealerName = clean;
    if (cmd.account) s.dealerAccount = cmd.account;
    if (s.dealerGoneAt) log(s, now, 'ディーラーが戻りました');
    s.dealerGoneAt = null;
    return;
  }
  if (s.banned.includes(userId)) throw new RoomError('BANNED', 'この卓からキックされています');
  const existing = s.seats.find((x) => x.userId === userId);
  if (existing) {
    existing.name = clean;
    if (cmd.account) existing.account = cmd.account;
    // 再接続: ハンドの合間なら保存済みの残高に合わせ直す（別の卓で増減していた場合など）
    const hp = s.hand?.players.find((p) => p.userId === userId);
    const between = s.phase === 'WAITING' || (s.phase === 'BETTING' && hp?.status !== 'CONFIRMED');
    if (between && cmd.balance !== undefined) existing.balance = balance;
    return;
  }
  if (cmd.watch) return; // 観戦: 席には着かない
  if (s.seats.length >= s.config.maxSeats) throw new RoomError('ROOM_FULL', '満席です');
  const used = new Set(s.seats.map((x) => x.seat));
  let seat = 0;
  while (used.has(seat)) seat++;
  s.seats.push({
    userId,
    name: clean,
    seat,
    balance,
    addonTotal: 0,
    sessionNet: 0,
    preset: null,
    kicked: false,
    leaving: false,
    account: cmd.account,
  });
  s.seats.sort((a, b) => a.seat - b.seat);
  if (s.phase === 'BETTING' && s.hand) s.hand.players.push(newHandPlayer(userId));
  log(s, now, `${clean} が着席しました`);
}

// ================================================================== 進行

function advance(s: RoomState, ctx: Ctx): void {
  const { now } = ctx;
  switch (s.phase) {
    case 'WAITING': {
      s.handNo++;
      s.resultUntil = null;
      s.hand = {
        handNo: s.handNo,
        startedAt: now,
        deck: [],
        dealerHole: [],
        community: [],
        revealed: 0,
        players: s.seats
          .filter((x) => !x.kicked && !x.leaving)
          // 離席中の人は最初から見送り（ベット待ちで進行を止めない）
          .map((x) => ({ ...newHandPlayer(x.userId), status: x.away ? ('SITTING_OUT' as const) : ('BETTING' as const) })),
        pending: [],
        deadline: now + s.config.betSeconds * 1000,
        jackpot: null,
        fair: newFair(ctx),
      };
      s.phase = 'BETTING';
      log(s, now, `ハンド #${s.handNo} ベット受付開始`);
      return;
    }
    case 'BETTING': {
      const hand = s.hand!;
      const confirmed = hand.players.filter((p) => p.status === 'CONFIRMED');
      if (confirmed.length === 0) {
        s.hand = null;
        s.phase = 'WAITING';
        log(s, now, `ハンド #${s.handNo} は参加者がいないため無効になりました`);
        return;
      }
      // 山札はサーバーシード（コミット済み）と参加者のクライアントシードから決まる（検算方法は engine/fair.ts）
      const fair = (hand.fair ??= newFair(ctx));
      const order = confirmed.map((p) => p.userId);
      fair.clientSeeds = Object.fromEntries(Object.entries(fair.clientSeeds).filter(([id]) => order.includes(id)));
      fair.order = order;
      const deck = fairDeck(fair.serverSeed, combineClientSeeds(fair.clientSeeds), hand.handNo);
      const dealt = dealFromDeck(deck, order);
      for (const p of confirmed) p.hole = dealt.holes[p.userId]!;
      hand.dealerHole = dealt.dealer;
      hand.community = dealt.community;
      hand.deck = deck.slice(order.length * 2 + 7);
      hand.players = confirmed;
      s.phase = 'PREFLOP';
      log(s, now, `ディール（${confirmed.length} 人参加）`);
      enterStreet(s, 'PREFLOP', now);
      return;
    }
    case 'PREFLOP': {
      const hand = s.hand!;
      hand.revealed = 3;
      hand.jackpot = settleJackpot({
        entries: hand.players.map((p) => ({ playerId: p.userId, hole: p.hole, bet: p.bets.jackpot })),
        flop: hand.community.slice(0, 3),
        poolBefore: s.jackpotPool,
      });
      s.phase = 'FLOP';
      log(s, now, 'フロップ公開');
      enterStreet(s, 'FLOP', now);
      return;
    }
    case 'FLOP':
      s.hand!.revealed = 5;
      s.phase = 'RIVER';
      log(s, now, 'ターン・リバー公開');
      enterStreet(s, 'RIVER', now);
      return;
    case 'RIVER':
      // ショーダウン: まずフォールドしていないプレイヤー全員の手札を公開する
      s.hand!.dealerRevealed = 0;
      s.phase = 'SHOWDOWN';
      log(s, now, 'ショーダウン: プレイヤーの手札を公開');
      return;
    case 'SHOWDOWN':
      if (!s.hand!.dealerRevealed) {
        // ディーラーの 1 枚目（ディーラー本人もここで初めて知る）
        s.hand!.dealerRevealed = 1;
        log(s, now, `ディーラー 1 枚目: ${s.hand!.dealerHole[0]}`);
        return;
      }
      // 2 枚目をめくって精算
      s.hand!.dealerRevealed = 2;
      log(s, now, `ディーラー 2 枚目: ${s.hand!.dealerHole[1]}`);
      return showdown(s, now);
  }
}

function newFair(ctx: Ctx): NonNullable<HandState['fair']> {
  const serverSeed = ctx.serverSeed?.() ?? newServerSeed();
  return { serverSeed, commit: commitOf(serverSeed), clientSeeds: {} };
}

/** 精算後に公開する検算用の記録 */
function fairRecord(hand: HandState): FairRecord | undefined {
  const f = hand.fair;
  if (!f?.order) return undefined;
  return { handNo: hand.handNo, commit: f.commit, serverSeed: f.serverSeed, clientSeeds: { ...f.clientSeeds }, order: [...f.order] };
}

function enterStreet(s: RoomState, street: Street, now: number): void {
  const hand = s.hand!;
  hand.pending = hand.players.filter((p) => needsActionOn(p.actions, street)).map((p) => p.userId);
  hand.deadline = hand.pending.length ? now + s.config.actionSeconds * 1000 : null;
  autoActKicked(s, now);
}

function recordAction(s: RoomState, hand: HandState, hp: HandPlayer, rec: ActionRecord, name: string, now: number): void {
  hp.actions.push(rec);
  resolveDecision(hp.actions); // 念のため履歴全体を再検証
  hand.pending = hand.pending.filter((id) => id !== hp.userId);
  if (hand.pending.length === 0) hand.deadline = null;
  log(s, now, `${name}: ${ACTION_LABEL[rec.action]}${rec.auto ? '（自動）' : ''}`);
}

function autoActKicked(s: RoomState, now: number): void {
  const hand = s.hand;
  const street = phaseStreet(s.phase);
  if (!hand || !street) return;
  for (const id of [...hand.pending]) {
    const seat = s.seats.find((x) => x.userId === id);
    if (!seat?.kicked) continue;
    const hp = hand.players.find((p) => p.userId === id)!;
    recordAction(s, hand, hp, { street, action: TIMEOUT_ACTION[street], auto: true }, seat.name, now);
  }
}

/** ディーラー不在でハンドを無効にする（ベットは精算まで残高から引いていないので、破棄すれば全額返金になる） */
function voidHandForAbsentDealer(s: RoomState, now: number): void {
  log(s, now, `ディーラーが ${DEALER_VOID_MS / 60000} 分戻らなかったため、ハンド #${s.handNo} を無効にしました（全額返金）`);
  s.hand = null;
  s.phase = 'WAITING';
  s.dealerGoneAt = null;
  s.resultUntil = null;
  for (const seat of s.seats.filter((x) => x.kicked || x.leaving)) removeSeat(s, seat.userId);
}

function timeout(s: RoomState, now: number): void {
  const voidAt = dealerVoidAt(s);
  if (voidAt && now >= voidAt) return voidHandForAbsentDealer(s, now);
  const idleAt = idleCloseAt(s);
  if (idleAt && now >= idleAt) {
    s.closed = true;
    log(s, now, `${IDLE_CLOSE_MS / 3_600_000} 時間操作がなかったため、卓を自動で解散しました`);
    return;
  }
  const hand = s.hand;
  if (!hand) {
    // 結果表示時間の終了（ロック解除を配信するだけ）
    if (s.resultUntil && now >= s.resultUntil) s.resultUntil = null;
    return;
  }
  if (hand.deadline === null || now < hand.deadline) return;
  if (s.phase === 'BETTING') {
    for (const p of hand.players) {
      if (p.status !== 'BETTING') continue;
      p.status = 'SITTING_OUT';
      log(s, now, `${seatName(s, p.userId)} はベット締切のため見送り`);
    }
    hand.deadline = null;
    return;
  }
  const street = phaseStreet(s.phase);
  if (!street) return;
  for (const id of [...hand.pending]) {
    const hp = hand.players.find((p) => p.userId === id)!;
    recordAction(s, hand, hp, { street, action: TIMEOUT_ACTION[street], auto: true }, seatName(s, id), now);
  }
}

function showdown(s: RoomState, now: number): void {
  const hand = s.hand!;
  const result = settleHand({
    dealerHole: hand.dealerHole,
    community: hand.community,
    players: hand.players.map((p) => ({ playerId: p.userId, hole: p.hole, bets: p.bets, actions: p.actions })),
    jackpotPoolBefore: s.jackpotPool,
  });

  for (const r of result.players) {
    const seat = s.seats.find((x) => x.userId === r.playerId)!;
    seat.balance += r.net;
    seat.sessionNet += r.net;
  }
  s.dealerSessionNet += result.dealer.net;
  s.jackpotPool = result.jackpot.poolAfter;
  s.handsPlayed++;
  s.history = [
    ...(s.history ?? []),
    {
      handNo: hand.handNo,
      at: now,
      dealerNet: result.dealer.net,
      dealerNetInclJackpot: result.dealer.net + (result.jackpot.poolAfter - result.jackpot.poolBefore),
      players: result.players.map((r) => ({ userId: r.playerId, name: seatName(s, r.playerId), net: r.net })),
    },
  ].slice(-HISTORY_LIMIT);

  s.lastResult = {
    handNo: hand.handNo,
    board: hand.community,
    dealer: {
      hole: hand.dealerHole,
      category: result.dealer.hand.category,
      bestCards: result.dealer.hand.cards,
      qualified: result.dealer.qualified,
      net: result.dealer.net,
      netInclJackpot: result.dealer.net + (result.jackpot.poolAfter - result.jackpot.poolBefore),
    },
    players: result.players.map((r) => {
      const folded = r.outcome === 'FOLD';
      const hp = hand.players.find((p) => p.userId === r.playerId)!;
      return {
        userId: r.playerId,
        name: seatName(s, r.playerId),
        hole: folded ? null : hp.hole,
        category: folded ? null : r.hand.category,
        bestCards: folded ? null : r.hand.cards,
        outcome: r.outcome,
        lines: {
          ante: r.lines.ante.net,
          blind: r.lines.blind.net,
          play: r.lines.play.net,
          trips: r.lines.trips.net,
          jackpot: r.lines.jackpot.net,
        },
        stakes: {
          ante: r.lines.ante.stake,
          blind: r.lines.blind.stake,
          play: r.lines.play.stake,
          trips: r.lines.trips.stake,
          jackpot: r.lines.jackpot.stake,
        },
        // JP の役は当たった場合のみ公開（フォールドした人の手札が推測されないように）
        jackpot: {
          category: r.lines.jackpot.prize > 0 ? r.lines.jackpot.hand!.category : null,
          prize: r.lines.jackpot.prize,
          envy: r.lines.jackpot.envy,
        },
        net: r.net,
      };
    }),
    jackpot: {
      poolBefore: result.jackpot.poolBefore,
      poolAfter: result.jackpot.poolAfter,
      dealerTopUp: result.jackpot.dealerTopUp,
      royalFlushHit: result.jackpot.royalFlushHit,
    },
    // 精算が済んだのでサーバーシードを公開（誰でも山札を検算できる）
    fair: fairRecord(hand),
  };

  // 各プレイヤーの「自分のハンド履歴」（フォールドした手札も本人には見せる）
  for (const p of s.lastResult.players) {
    const seat = s.seats.find((x) => x.userId === p.userId);
    const hp = hand.players.find((x) => x.userId === p.userId)!;
    if (!seat) continue;
    const d = resolveDecision(hp.actions);
    seat.hands = [
      ...(seat.hands ?? []),
      {
        handNo: hand.handNo,
        at: now,
        hole: hp.hole,
        board: hand.community,
        dealerHole: hand.dealerHole,
        category: p.category,
        dealerCategory: result.dealer.hand.category,
        dealerQualified: result.dealer.qualified,
        outcome: p.outcome,
        playMultiplier: d.status === 'PLAYED' ? d.multiplier : 0,
        stakes: p.stakes,
        lines: p.lines,
        jackpot: p.jackpot,
        net: p.net,
        fair: s.lastResult.fair,
      },
    ].slice(-HISTORY_LIMIT);
  }

  const poolDelta = result.jackpot.poolAfter - result.jackpot.poolBefore;
  enqueue(s, {
    kind: 'HAND',
    id: `${sessionId(s)}#${hand.handNo}`,
    handNo: hand.handNo,
    dealer: {
      id: s.dealerId,
      name: s.dealerName,
      account: s.dealerAccount ?? s.dealerId,
      hole: hand.dealerHole,
      category: result.dealer.hand.category,
      qualified: result.dealer.qualified,
      net: result.dealer.net + poolDelta,
      netTable: result.dealer.net,
    },
    community: hand.community,
    pool: { before: result.jackpot.poolBefore, after: result.jackpot.poolAfter },
    fair: fairRecord(hand),
    players: result.players.map((r) => {
      const seat = s.seats.find((x) => x.userId === r.playerId);
      return {
        id: r.playerId,
        name: seatName(s, r.playerId),
        account: seat?.account ?? r.playerId,
        hole: hand.players.find((p) => p.userId === r.playerId)!.hole,
        outcome: r.outcome,
        category: r.outcome === 'FOLD' ? null : r.hand.category,
        lines: {
          ante: r.lines.ante.net,
          blind: r.lines.blind.net,
          play: r.lines.play.net,
          trips: r.lines.trips.net,
          jackpot: r.lines.jackpot.net,
        },
        jpPrize: r.lines.jackpot.prize,
        net: r.net,
      };
    }),
    sessionId: sessionId(s),
    roomCode: s.roomCode,
    at: now,
    done: {},
  });

  // 結果を見る時間（この間は次のハンドを開始できない）
  s.resultUntil = now + s.config.resultSeconds * 1000;

  log(s, now, `ハンド #${hand.handNo} 精算完了（ディーラー ${signed(result.dealer.net)}）`);
  for (const seat of s.seats.filter((x) => x.kicked || x.leaving)) removeSeat(s, seat.userId);
  s.hand = null;
  s.phase = 'WAITING';
}

// ================================================================== ロック判定

export function lockState(s: RoomState, now: number): Omit<DealerControls, 'next'> {
  const names = (ids: string[]) => ids.map((id) => seatName(s, id));
  switch (s.phase) {
    case 'WAITING': {
      if (s.resultUntil && now < s.resultUntil) {
        return { canAdvance: false, lockReason: '結果表示中', waitingFor: [] };
      }
      const n = s.seats.filter((x) => !x.kicked).length;
      return n > 0
        ? { canAdvance: true, lockReason: null, waitingFor: [] }
        : { canAdvance: false, lockReason: '着席しているプレイヤーがいません', waitingFor: [] };
    }
    case 'BETTING': {
      const waiting = s.hand!.players.filter((p) => p.status === 'BETTING').map((p) => p.userId);
      return waiting.length
        ? { canAdvance: false, lockReason: `ベット待ち: ${names(waiting).join(', ')}`, waitingFor: waiting }
        : { canAdvance: true, lockReason: null, waitingFor: [] };
    }
    default: {
      const pending = s.hand!.pending;
      return pending.length
        ? { canAdvance: false, lockReason: `アクション待ち: ${names(pending).join(', ')}`, waitingFor: [...pending] }
        : { canAdvance: true, lockReason: null, waitingFor: [] };
    }
  }
}

const NEXT_BUTTON: Record<Phase, DealerControls['next']> = {
  WAITING: 'START_HAND',
  BETTING: 'DEAL',
  PREFLOP: 'FLOP',
  FLOP: 'TURN_RIVER',
  RIVER: 'SHOWDOWN',
  SHOWDOWN: 'REVEAL_DEALER_1',
};

// ================================================================== ビュー（マスキング）

export function viewFor(s: RoomState, userId: string, now: number, connected: ReadonlySet<string>): RoomView {
  const hand = s.hand;
  const isDealer = userId === s.dealerId;
  const mySeat = s.seats.find((x) => x.userId === userId);

  const seats: PublicSeat[] = s.seats.map((seat) => {
    const hp = hand?.players.find((p) => p.userId === seat.userId);
    const showBets = hp && (hp.status === 'CONFIRMED' || s.phase !== 'BETTING');
    return {
      userId: seat.userId,
      name: seat.name,
      seat: seat.seat,
      // Bot は卓の中で動いているので常に「接続中」
      connected: !!seat.bot || connected.has(seat.userId),
      available: seat.balance - committed(hp),
      sessionNet: seat.sessionNet,
      status: seatStatus(s, hp),
      bets: hp && showBets ? { ...hp.bets, play: playAmount(hp) } : null,
      actions: hp && s.phase !== 'BETTING' ? hp.actions : [],
      shownHole: s.phase === 'SHOWDOWN' && hp && resolveDecision(hp.actions).status === 'PLAYED' ? hp.hole : null,
      isActing: !!hand?.pending.includes(seat.userId) || (s.phase === 'BETTING' && hp?.status === 'BETTING'),
      lowBalance: balanceWarning(s, seat) !== null,
      leavingAfterHand: seat.leaving || seat.kicked,
      away: !!seat.away,
      bot: !!seat.bot,
    };
  });

  let me: RoomView['me'] = null;
  if (mySeat) {
    const hp = hand?.players.find((p) => p.userId === userId);
    const street = phaseStreet(s.phase);
    const jp = hand?.jackpot?.players.find((p) => p.playerId === userId);
    me = {
      hole: hp && hp.hole.length ? hp.hole : null,
      legalActions: street && hand?.pending.includes(userId) ? [...LEGAL_ACTIONS[street]] : [],
      preset: mySeat.preset,
      jackpot:
        jp && jp.stake > 0 && hp
          ? { category: jp.hand!.category, cards: jp.hand!.cards, prize: jp.prize }
          : null,
      balanceWarning: balanceWarning(s, mySeat),
    };
  }

  return {
    roomCode: s.roomCode,
    demo: !!s.demo,
    serverNow: now,
    you: { userId, role: isDealer ? 'DEALER' : mySeat ? 'PLAYER' : 'SPECTATOR' },
    phase: s.phase,
    handNo: s.handNo,
    config: { ...DEFAULT_CONFIG, ...s.config },
    jackpotPool: s.jackpotPool,
    deadline: hand?.deadline ?? null,
    resultUntil: s.resultUntil && now < s.resultUntil ? s.resultUntil : null,
    dealerVoidAt: dealerVoidAt(s),
    dealer: {
      userId: s.dealerId,
      name: s.dealerName,
      connected: s.dealerId === demoDealerId(s) || connected.has(s.dealerId),
      sessionNet: s.dealerSessionNet + jackpotDelta(s),
      sessionNetExJackpot: s.dealerSessionNet,
      jackpotDelta: jackpotDelta(s),
    },
    board: hand ? hand.community.slice(0, hand.revealed) : [],
    dealerCards: hand ? hand.dealerHole.slice(0, hand.dealerRevealed ?? 0) : [],
    seats,
    me,
    dealerControls: isDealer
      ? { next: s.phase === 'SHOWDOWN' && hand?.dealerRevealed ? 'REVEAL_DEALER_2' : NEXT_BUTTON[s.phase], ...lockState(s, now) }
      : null,
    lastResult: s.lastResult,
    history: isDealer ? [...(s.history ?? [])].reverse() : null,
    myHands: mySeat ? [...(mySeat.hands ?? [])].reverse() : null,
    sessionPlayers: isDealer ? sessionPlayers(s).map(({ userId, name, net }) => ({ userId, name, net })) : null,
    spectators: [...connected].filter((id) => id !== s.dealerId && !s.seats.some((x) => x.userId === id)).length,
    demoOwner: !!s.demo && userId === s.demoOwner,
    // サーバーシードは精算まで送らない（コミットだけ）
    fair: hand?.fair ? { handNo: hand.handNo, commit: hand.fair.commit, myClientSeed: hand.fair.clientSeeds[userId] ?? null } : null,
    // 進行ログはディーラーだけ（プレイヤーは自分のハンド履歴を見る）
    log: isDealer ? s.log : [],
  };
}

/** 次のハンドに必要な残高が足りない場合の警告（ハンドの合間・ベット確定前のみ） */
export function balanceWarning(s: RoomState, seat: SeatState): BalanceWarning | null {
  const hp = s.hand?.players.find((p) => p.userId === seat.userId);
  const between = s.phase === 'WAITING' || (s.phase === 'BETTING' && hp?.status !== 'CONFIRMED');
  if (!between) return null;
  const { minAnte, maxAnte, maxTrips } = s.config;
  const p = seat.preset;
  const basis = p ? 'LAST_BET' : 'TABLE_MIN';
  const required = requiredBalance({
    ante: p ? clamp(p.ante, minAnte, maxAnte) : minAnte,
    trips: p ? Math.min(p.trips, maxTrips) : 0,
    jackpot: p?.jackpot ? DEFAULT_RULES.jackpotBetAmount : 0,
  });
  if (seat.balance >= required) return null;
  return { required, available: seat.balance, shortfall: required - seat.balance, basis };
}

/** ロビー一覧用の概要（updatedAt はロビー側で付与） */
export function lobbySummary(s: RoomState, dealerConnected: boolean): Omit<LobbyRoom, 'updatedAt'> {
  return {
    code: s.roomCode,
    dealerName: s.dealerName,
    dealerConnected,
    players: s.seats.length,
    maxSeats: s.config.maxSeats,
    phase: s.phase,
    handNo: s.handNo,
    minAnte: s.config.minAnte,
    maxAnte: s.config.maxAnte,
    jackpotPool: s.jackpotPool,
    createdAt: s.createdAt,
    demo: !!s.demo,
  };
}

/** セッション開始時からの JP プール増減（プールはディーラーの持ち分として集計する） */
export function jackpotDelta(s: RoomState): number {
  return s.jackpotPool - (s.poolAtStart ?? DEFAULT_RULES.jackpotSeed);
}

export function sessionSummary(s: RoomState): SessionSummary {
  return {
    roomCode: s.roomCode,
    handsPlayed: s.handsPlayed,
    dealerNet: s.dealerSessionNet + jackpotDelta(s),
    dealerNetExJackpot: s.dealerSessionNet,
    jackpotDelta: jackpotDelta(s),
    jackpotPool: s.jackpotPool,
    players: sessionPlayers(s),
  };
}

/** この卓で遊んだ全員の収支（途中で退席した人も含む。同じ人が座り直した分はまとめる。収支の大きい順） */
export function sessionPlayers(s: RoomState): SessionSummary['players'] {
  const byUser = new Map<string, SessionSummary['players'][number]>();
  const add = (p: SessionSummary['players'][number]) => {
    const cur = byUser.get(p.userId);
    byUser.set(p.userId, cur ? { ...p, net: cur.net + p.net, addon: cur.addon + p.addon } : { ...p });
  };
  for (const d of s.departed ?? []) add(d);
  for (const x of s.seats) add({ userId: x.userId, name: x.name, net: x.sessionNet, addon: x.addonTotal, balance: x.balance });
  return [...byUser.values()].sort((a, b) => b.net - a.net);
}

// ================================================================== ヘルパー

const ACTION_LABEL = {
  PLAY_4X: 'プレイ 4倍',
  PLAY_3X: 'プレイ 3倍',
  PLAY_2X: 'プレイ 2倍',
  PLAY_1X: 'プレイ 1倍',
  CHECK: 'チェック',
  FOLD: 'フォールド',
} as const;

function phaseStreet(phase: Phase): Street | null {
  return phase === 'PREFLOP' || phase === 'FLOP' || phase === 'RIVER' ? phase : null;
}

function seatStatus(s: RoomState, hp: HandPlayer | undefined): SeatStatus {
  if (!s.hand) return 'IDLE';
  if (!hp) return s.phase === 'BETTING' ? 'IDLE' : 'SITTING_OUT';
  if (s.phase === 'BETTING') {
    return hp.status === 'CONFIRMED' ? 'BET_CONFIRMED' : hp.status === 'SITTING_OUT' ? 'SITTING_OUT' : 'BETTING';
  }
  return 'IN_HAND';
}

function playAmount(hp: HandPlayer): number {
  const d = resolveDecision(hp.actions);
  return d.status === 'PLAYED' ? hp.bets.ante * d.multiplier : 0;
}

function committed(hp: HandPlayer | undefined): number {
  if (!hp || hp.status !== 'CONFIRMED') return 0;
  const b = hp.bets;
  return b.ante + b.blind + b.trips + b.jackpot + playAmount(hp);
}

function inDealtHand(s: RoomState, userId: string): boolean {
  return s.phase !== 'WAITING' && s.phase !== 'BETTING' && !!s.hand?.players.some((p) => p.userId === userId);
}

/** デモ卓で作った人がプレイヤーの間、ディーラーを務める Bot の ID */
export function demoDealerId(s: Pick<RoomState, 'roomCode'>): string {
  return `bot:${s.roomCode}:dealer`;
}

function removeSeat(s: RoomState, userId: string): void {
  const seat = s.seats.find((x) => x.userId === userId);
  // 収支は卓を離れても残す（ゲーム終了時の一覧用）
  if (seat && (seat.sessionNet !== 0 || seat.addonTotal !== 0)) {
    s.departed = [
      ...(s.departed ?? []),
      { userId, name: seat.name, net: seat.sessionNet, addon: seat.addonTotal, balance: seat.balance },
    ];
  }
  s.seats = s.seats.filter((x) => x.userId !== userId);
  if (s.hand && s.phase === 'BETTING') s.hand.players = s.hand.players.filter((p) => p.userId !== userId);
}

function newHandPlayer(userId: string): HandPlayer {
  return { userId, status: 'BETTING', bets: zeroBets(), hole: [], actions: [] };
}

function zeroBets(): PlayerBets {
  return { ante: 0, blind: 0, trips: 0, jackpot: 0 };
}

function requireSeat(s: RoomState, userId: string): SeatState {
  const seat = s.seats.find((x) => x.userId === userId);
  if (!seat) throw new RoomError('NOT_SEATED', '着席していません');
  return seat;
}

function requireDealer(s: RoomState, userId: string): void {
  if (userId !== s.dealerId) throw new RoomError('NOT_DEALER', 'ディーラーのみ操作できます');
}

function bettingPlayer(s: RoomState, userId: string, handNo: number): { seat: SeatState; hp: HandPlayer } {
  const seat = requireSeat(s, userId);
  if (s.phase !== 'BETTING') throw new RoomError('BAD_PHASE', 'ベット受付中ではありません');
  if (handNo !== s.handNo) throw new RoomError('STALE', '画面が古くなっています');
  const hp = s.hand!.players.find((p) => p.userId === userId);
  if (!hp) throw new RoomError('NOT_SEATED', 'このハンドには参加できません');
  return { seat, hp };
}

function validateBet(s: RoomState, seat: SeatState, bet: BetRequest): BetRequest {
  const { minAnte, maxAnte, maxTrips } = s.config;
  if (!bet || !Number.isSafeInteger(bet.ante) || !Number.isSafeInteger(bet.trips) || typeof bet.jackpot !== 'boolean') {
    throw new RoomError('INVALID_BET', 'ベット額が不正です');
  }
  if (bet.ante < minAnte || bet.ante > maxAnte) throw new RoomError('INVALID_BET', `アンティは ${minAnte}〜${maxAnte} です`);
  if (bet.trips < 0 || bet.trips > maxTrips) throw new RoomError('INVALID_BET', `トリップスは 0〜${maxTrips} です`);
  const required = requiredBalance({ ante: bet.ante, trips: bet.trips, jackpot: bet.jackpot ? DEFAULT_RULES.jackpotBetAmount : 0 });
  if (seat.balance < required) {
    throw new RoomError(
      'INSUFFICIENT_BALANCE',
      `このベットには残高 ${required.toLocaleString()} が必要です（アンティ×6 + トリップス + JP）。現在 ${seat.balance.toLocaleString()}`,
    );
  }
  return { ante: bet.ante, trips: bet.trips, jackpot: bet.jackpot };
}

function validateConfig(c: RoomConfig): RoomConfig {
  const intIn = (v: number, lo: number, hi: number, label: string) => {
    if (!Number.isSafeInteger(v) || v < lo || v > hi) throw new RoomError('BAD_REQUEST', `${label} は ${lo}〜${hi} の整数です`);
  };
  intIn(c.minAnte, 1, 1_000_000, '最小アンティ');
  intIn(c.maxAnte, c.minAnte, 1_000_000, '最大アンティ');
  intIn(c.maxTrips, 0, 1_000_000, 'トリップス上限');
  intIn(c.betSeconds, 5, 300, 'ベット制限時間');
  intIn(c.actionSeconds, 5, 300, 'アクション制限時間');
  intIn(c.resultSeconds, 0, 60, '結果表示時間');
  intIn(c.maxSeats, 1, 7, '最大席数');
  return { ...c };
}

function sanitizeName(name: string): string {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return n || 'ゲスト';
}

function seatName(s: RoomState, userId: string): string {
  return s.seats.find((x) => x.userId === userId)?.name ?? '(退席済み)';
}

function log(s: RoomState, at: number, text: string): void {
  s.log.push({ at, text });
  if (s.log.length > LOG_LIMIT) s.log.splice(0, s.log.length - LOG_LIMIT);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function signed(n: number): string {
  return (n >= 0 ? '+' : '') + n.toLocaleString();
}
