/** 公正性レポートの HTML（Artifact としても、単体のファイルとしても開ける形） */
import type { Summary } from './report.js';

const fmt = (n: number, d = 0) => n.toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (r: number, d = 2) => `${(r * 100).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d })}%`;
const pv = (p: number) => (p < 0.0001 ? '< 0.0001' : p.toFixed(4));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** p 値の判定: 0.001 未満なら「要確認」（多数の検定をしているので、0.05 未満はたまたまでも時々出る） */
const verdictOf = (p: number) => (p < 0.001 ? 'flag' : p < 0.05 ? 'note' : 'ok');
const badge = (p: number) => {
  const v = verdictOf(p);
  return `<span class="pill ${v}">${v === 'ok' ? '偏りなし' : v === 'note' ? 'やや外れ（偶然の範囲）' : '要確認'}</span>`;
};

/** 期待値からのずれ（標準偏差いくつ分か）を −4〜+4 の目盛りに点で描く。±2 の帯に収まっていれば普通 */
function zStrip(z: number): string {
  const W = 160;
  const clamp = Math.max(-4, Math.min(4, z));
  const x = ((clamp + 4) / 8) * W;
  return `<svg class="zs" viewBox="0 0 ${W} 18" width="${W}" height="18" role="img" aria-label="ずれ ${z.toFixed(2)}σ">
    <rect x="${W / 4}" y="3" width="${W / 2}" height="12" rx="2" class="zs-band"/>
    <line x1="${W / 2}" y1="1" x2="${W / 2}" y2="17" class="zs-mid"/>
    <circle cx="${x.toFixed(1)}" cy="9" r="4.5" class="zs-dot ${Math.abs(z) > 3 ? 'far' : ''}"/>
  </svg>`;
}

function categoryTable(title: string, lead: string, t: Summary['player7'], n: number): string {
  const rows = t.rows
    .map((r) => {
      const z = (r.observed - r.expected) / Math.sqrt(r.expected);
      return `<tr>
        <th scope="row">${r.name}</th>
        <td class="num">${fmt(r.observed)}</td>
        <td class="num">${fmt(r.expected, 1)}</td>
        <td class="num">${pct(r.rate, r.expectedRate < 0.001 ? 4 : 2)}</td>
        <td class="num muted">${pct(r.expectedRate, r.expectedRate < 0.001 ? 4 : 2)}</td>
        <td>${zStrip(z)}</td>
      </tr>`;
    })
    .join('');
  return `<section class="block">
    <div class="block-head"><h3>${title}</h3>${badge(t.p)}</div>
    <p class="lead">${lead}</p>
    <div class="scroll"><table>
      <thead><tr><th>役</th><th class="num">回数</th><th class="num">理論上の回数</th><th class="num">出現率</th><th class="num">理論値</th><th>ずれ</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="stat">カイ二乗 = ${t.chi.toFixed(2)}（自由度 ${t.df}）・p 値 = ${pv(t.p)}<span class="muted">（ロイヤルはストレートフラッシュとまとめて検定。${fmt(n)} ハンド）</span></p>
  </section>`;
}

export function renderReport(s: Summary): string {
  const tests = [
    s.allCards.p,
    ...s.positions.map((p) => p.p),
    s.starting.p,
    s.player7.p,
    s.dealer7.p,
    s.jp5.p,
    s.showdown.p,
    s.dealerQualify.p,
    s.serial.p,
  ];
  const flagged = tests.filter((p) => p < 0.001).length;
  const noted = tests.filter((p) => p >= 0.001 && p < 0.05).length;
  const allOk = flagged === 0;

  const cards = s.allCards.cards
    .map((c) => {
      const z = (c.count - s.allCards.expected) / Math.sqrt(s.allCards.expected);
      const suit = c.card[1];
      const sym = { s: '♠', h: '♥', d: '♦', c: '♣' }[suit as 's']!;
      const rank = c.card[0] === 'T' ? '10' : c.card[0];
      return `<div class="cardcell ${suit === 'h' || suit === 'd' ? 'red' : ''}" title="${fmt(c.count)} 回（${z >= 0 ? '+' : ''}${z.toFixed(2)}σ）">
        <span class="cc-face">${rank}${sym}</span><span class="cc-n">${fmt(c.count)}</span><span class="cc-z ${Math.abs(z) > 2 ? 'hi' : ''}">${z >= 0 ? '+' : ''}${z.toFixed(1)}</span>
      </div>`;
    })
    .join('');

  const posRows = s.positions
    .map(
      (p) => `<tr><th scope="row">${p.label}</th><td class="num">${fmt(p.min)}〜${fmt(p.max)}</td><td class="num">${p.chi.toFixed(1)}</td><td class="num">${pv(p.p)}</td><td>${badge(p.p)}</td></tr>`,
    )
    .join('');

  const sd = s.showdown;
  const sdTotal = sd.win + sd.lose + sd.tie;

  return `<meta charset="utf-8">
<title>UTH 公正性レポート</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans+JP:wght@400;500;700&display=swap">
<style>
:root {
  --bg: #f4f6f4;
  --surface: #ffffff;
  --ink: #17211d;
  --muted: #5b6a64;
  --rule: #d6ddd9;
  --felt: #1d6b48;
  --felt-soft: #e3efe8;
  --ok: #1f7a4d;
  --note: #9a6a00;
  --flag: #b3261e;
  --band: #d8ebe0;
  --red-suit: #c0242b;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0f1513; --surface: #161e1b; --ink: #e4ebe7; --muted: #93a39c; --rule: #2a3531;
    --felt: #5cc293; --felt-soft: #1b2b24; --ok: #5cc293; --note: #e0b44a; --flag: #ff8a80; --band: #20352b; --red-suit: #ff7b7f;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #0f1513; --surface: #161e1b; --ink: #e4ebe7; --muted: #93a39c; --rule: #2a3531;
  --felt: #5cc293; --felt-soft: #1b2b24; --ok: #5cc293; --note: #e0b44a; --flag: #ff8a80; --band: #20352b; --red-suit: #ff7b7f;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 15px/1.7 'IBM Plex Sans JP', 'Hiragino Sans', 'Yu Gothic UI', system-ui, sans-serif;
}
.wrap { max-width: 900px; margin: 0 auto; padding-inline: 20px; padding-block: 32px 64px; display: grid; gap: 28px; }
h1, h2, h3 { text-wrap: balance; line-height: 1.3; margin: 0; }
h1 { font-size: 1.9rem; letter-spacing: 0.01em; }
h2 { font-size: 1.25rem; padding-bottom: 6px; border-bottom: 2px solid var(--felt); }
h3 { font-size: 1.02rem; }
p { margin: 0; max-width: 68ch; }
.eyebrow { font-size: 0.78rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--felt); font-weight: 700; }
.muted { color: var(--muted); }
code, .mono, .num { font-family: 'IBM Plex Mono', ui-monospace, Consolas, monospace; font-variant-numeric: tabular-nums; }
code { font-size: 0.82em; overflow-wrap: anywhere; word-break: break-all; }
header { display: grid; gap: 10px; }
.verdict {
  display: grid; gap: 10px; padding: 18px 20px; border-radius: 14px;
  background: var(--felt-soft); border: 1px solid var(--rule);
}
.verdict .big { font-size: 1.3rem; font-weight: 700; }
.verdict.ok .big { color: var(--ok); }
.verdict.flag .big { color: var(--flag); }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px 20px; margin: 0; }
.facts div { display: grid; gap: 0; }
.facts dt { font-size: 0.78rem; color: var(--muted); }
.facts dd { margin: 0; font-weight: 600; font-family: 'IBM Plex Mono', ui-monospace, monospace; overflow-wrap: anywhere; }
section { display: grid; gap: 14px; }
.block { display: grid; gap: 8px; padding: 16px 18px; background: var(--surface); border: 1px solid var(--rule); border-radius: 12px; }
.block-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: space-between; }
.lead { color: var(--muted); font-size: 0.92rem; }
.stat { font-size: 0.85rem; }
.pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 0.78rem; font-weight: 700; white-space: nowrap; border: 1px solid currentColor; }
.pill.ok { color: var(--ok); }
.pill.note { color: var(--note); }
.pill.flag { color: var(--flag); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--rule); vertical-align: middle; }
thead th { font-size: 0.78rem; color: var(--muted); font-weight: 500; }
td.num, th.num { text-align: right; white-space: nowrap; }
tbody th { font-weight: 500; white-space: nowrap; }
.zs { display: block; }
.zs-band { fill: var(--band); }
.zs-mid { stroke: var(--muted); stroke-width: 1; }
.zs-dot { fill: var(--felt); }
.zs-dot.far { fill: var(--flag); }
.legend { display: flex; align-items: center; gap: 8px; font-size: 0.82rem; color: var(--muted); flex-wrap: wrap; }
.cards { display: grid; grid-template-columns: repeat(13, minmax(0, 1fr)); gap: 4px; }
@media (max-width: 640px) { .cards { grid-template-columns: repeat(7, minmax(0, 1fr)); } }
.cardcell { display: grid; justify-items: center; gap: 0; padding: 4px 2px; border: 1px solid var(--rule); border-radius: 6px; background: var(--surface); line-height: 1.25; }
.cc-face { font-weight: 700; font-size: 0.9rem; }
.cardcell.red .cc-face { color: var(--red-suit); }
.cc-n { font-family: 'IBM Plex Mono', monospace; font-size: 0.66rem; color: var(--muted); }
.cc-z { font-family: 'IBM Plex Mono', monospace; font-size: 0.66rem; }
.cc-z.hi { color: var(--note); font-weight: 600; }
.pairs { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.kv { display: grid; gap: 2px; }
.kv b { font-size: 1.25rem; font-family: 'IBM Plex Mono', monospace; font-weight: 600; }
ol.steps { margin: 0; padding-left: 1.3em; display: grid; gap: 6px; max-width: 72ch; }
.note-box { font-size: 0.88rem; color: var(--muted); border-left: 3px solid var(--rule); padding-left: 12px; }
.back { margin: 0; }
.back a { color: var(--felt); font-weight: 600; text-decoration: none; }
.back a:hover { text-decoration: underline; }
</style>
<div class="wrap">
  <p class="back"><a href="/">← トップへ</a></p>
  <header>
    <div class="eyebrow">Ultimate Texas Hold'em · Provably Fair</div>
    <h1>公正性レポート（${fmt(s.hands)} ハンド）</h1>
    <p class="muted">アプリの本番と同じ方法（プルーブリーフェア）で山札を作って ${fmt(s.hands)} ハンド配り、カードや役の出方に偏りがないかを統計で調べました。すべてのハンドは下のシードから誰でも計算し直せます。</p>
  </header>

  <div class="verdict ${allOk ? 'ok' : 'flag'}">
    <div class="big">${allOk ? '偏りは見つかりませんでした' : `要確認の項目が ${flagged} 件あります`}</div>
    <p>${tests.length} 種類の検定のうち、「要確認」（p 値 0.001 未満）は ${flagged} 件、「やや外れ」（0.001〜0.05）は ${noted} 件でした。
    本当にランダムでも、これだけ検定すれば 0.05 未満は平均 ${(tests.length * 0.05).toFixed(1)} 件ほど偶然に出ます。</p>
    <dl class="facts">
      <div><dt>ハンド数</dt><dd>${fmt(s.hands)}</dd></div>
      <div><dt>マスターシードのコミット</dt><dd>${s.master.commit.slice(0, 16)}…</dd></div>
      <div><dt>クライアントシード</dt><dd>${esc(s.clientSeed)}</dd></div>
      <div><dt>コミットの事前公開</dt><dd>${s.master.preCommitted ? 'あり' : 'なし（お試し実行）'}</dd></div>
    </dl>
  </div>

  <section>
    <h2>このレポートの作り方</h2>
    <ol class="steps">
      <li>運営がマスターシード（秘密の乱数）を作り、その SHA-256（コミット）だけを先に渡す。<br><code>${s.master.commit}</code></li>
      <li>確かめる人が好きな文字列（クライアントシード）を決めて運営に渡す。運営はこの文字列を事前に知り得ないので、都合のいい結果を選べない。</li>
      <li>ハンド i の山札 = マスターシードから作った serverSeed_i = HMAC-SHA256(マスターシード, "hand:i") と、クライアントシードから、アプリ本番と同じ手順で作る。</li>
      <li>配り終えたらマスターシードを公開する。SHA-256 がコミットと一致すること、hands.csv の各行が計算どおりであることを誰でも確かめられる（付属の verify_hand.py で 1 ハンドずつ検算できる）。</li>
    </ol>
    <p class="note-box">アプリで実際に遊ぶハンドも同じ仕組みです。ハンド開始前にコミットが表示され、精算後に公開されるシードで「このハンドを検証する」から計算し直せます。</p>
  </section>

  <section>
    <h2>カードの出方</h2>
    <div class="block">
      <div class="block-head"><h3>52 枚それぞれが配られた回数</h3>${badge(s.allCards.p)}</div>
      <p class="lead">1 ハンドで 9 枚（プレイヤー 2・ディーラー 2・ボード 5）配るので、1 枚あたりの理論上の回数は ${fmt(s.allCards.expected, 1)} 回。下の数字は回数と、理論値からのずれ（標準偏差いくつ分か。±2 以内が普通）。</p>
      <div class="cards">${cards}</div>
      <p class="stat">最少 ${fmt(s.allCards.min)} 回・最多 ${fmt(s.allCards.max)} 回・カイ二乗 = ${s.allCards.chi.toFixed(2)}（自由度 51）・p 値 = ${pv(s.allCards.p)}</p>
    </div>
    <div class="block">
      <div class="block-head"><h3>配る位置ごとの偏り</h3></div>
      <p class="lead">「ディーラーの 1 枚目にだけ A が多い」のような位置による偏りがないか。位置ごとに 52 枚の出現回数を検定。</p>
      <div class="scroll"><table>
        <thead><tr><th>位置</th><th class="num">回数の範囲</th><th class="num">カイ二乗</th><th class="num">p 値</th><th>判定</th></tr></thead>
        <tbody>${posRows}</tbody>
      </table></div>
    </div>
    <div class="block">
      <div class="block-head"><h3>プレイヤーの最初の 2 枚</h3>${badge(s.starting.p)}</div>
      <div class="pairs">
        <div class="kv"><span class="muted">ポケットペア</span><b>${pct(s.starting.pairs / s.hands)}</b><span class="muted">理論値 ${pct(s.starting.pairExp)}</span></div>
        <div class="kv"><span class="muted">スーテッド</span><b>${pct(s.starting.suited / s.hands)}</b><span class="muted">理論値 ${pct(s.starting.suitedExp)}</span></div>
        <div class="kv"><span class="muted">オフスート</span><b>${pct(s.starting.offsuit / s.hands)}</b><span class="muted">理論値 ${pct(1 - s.starting.pairExp - s.starting.suitedExp)}</span></div>
      </div>
      <p class="stat">カイ二乗 = ${s.starting.chi.toFixed(2)}（自由度 2）・p 値 = ${pv(s.starting.p)}</p>
    </div>
  </section>

  <section>
    <h2>役の出方</h2>
    <div class="legend">ずれの見方：${zStrip(0)} 帯の中（±2σ）なら普通、点が赤なら ±3σ 超</div>
    ${categoryTable('プレイヤーの役（手札 2 枚 + ボード 5 枚）', '7 枚から作る最良の 5 枚の役。理論値は全 133,784,560 通りを数えた確率。', s.player7, s.hands)}
    ${categoryTable('ディーラーの役（手札 2 枚 + ボード 5 枚）', 'ディーラーにだけ強い役が来ていないか。プレイヤーと同じ理論値になるはず。', s.dealer7, s.hands)}
    ${categoryTable('ジャックポットの役（手札 2 枚 + フロップ 3 枚）', 'JP の判定に使う 5 枚役。理論値は全 2,598,960 通りを数えた確率。', s.jp5, s.hands)}
  </section>

  <section>
    <h2>プレイヤー対ディーラー</h2>
    <div class="block">
      <div class="block-head"><h3>全員ショーダウンまで行った場合の勝敗</h3>${badge(sd.p)}</div>
      <p class="lead">カードの配り方が公平なら、プレイヤーとディーラーの立場は対称なので勝ち数と負け数はほぼ同じになる（ハウスエッジはカードではなく配当ルールから生まれる）。</p>
      <div class="pairs">
        <div class="kv"><span class="muted">プレイヤーの勝ち</span><b>${fmt(sd.win)}</b><span class="muted">${pct(sd.win / sdTotal)}</span></div>
        <div class="kv"><span class="muted">ディーラーの勝ち</span><b>${fmt(sd.lose)}</b><span class="muted">${pct(sd.lose / sdTotal)}</span></div>
        <div class="kv"><span class="muted">引き分け</span><b>${fmt(sd.tie)}</b><span class="muted">${pct(sd.tie / sdTotal)}</span></div>
      </div>
      <p class="stat">勝ちと負けの差 = ${fmt(sd.win - sd.lose)}（${sd.z >= 0 ? '+' : ''}${sd.z.toFixed(2)}σ）・p 値 = ${pv(sd.p)}</p>
    </div>
    <div class="block">
      <div class="block-head"><h3>ディーラーのクオリファイ率（ワンペア以上）</h3>${badge(s.dealerQualify.p)}</div>
      <div class="pairs">
        <div class="kv"><span class="muted">実際</span><b>${pct(s.dealerQualify.rate)}</b></div>
        <div class="kv"><span class="muted">理論値</span><b>${pct(s.dealerQualify.expected)}</b></div>
      </div>
      <p class="stat">${s.dealerQualify.z >= 0 ? '+' : ''}${s.dealerQualify.z.toFixed(2)}σ・p 値 = ${pv(s.dealerQualify.p)}</p>
    </div>
    <div class="block">
      <div class="block-head"><h3>前のハンドとのつながり</h3>${badge(s.serial.p)}</div>
      <p class="lead">プレイヤーの 1 枚目が前のハンドと同じカードになる割合。前のハンドの影響がなければ 1/52。</p>
      <div class="pairs">
        <div class="kv"><span class="muted">実際</span><b>${pct(s.serial.rate, 3)}</b><span class="muted">${fmt(s.serial.count)} 回</span></div>
        <div class="kv"><span class="muted">理論値</span><b>${pct(s.serial.expected, 3)}</b></div>
      </div>
      <p class="stat">${s.serial.z >= 0 ? '+' : ''}${s.serial.z.toFixed(2)}σ・p 値 = ${pv(s.serial.p)}</p>
    </div>
  </section>

  <section>
    <h2>読み方と限界</h2>
    <p>p 値は「本当にランダムだとしたら、これ以上ずれた結果がたまたま出る確率」です。小さいほど偏りを疑います。統計で言えるのは「偏りは見つからなかった」までで、ランダムであることの完全な証明にはなりません。</p>
    <p>その代わり、プルーブリーフェアの仕組みで「運営が結果を選べない」ことは 1 ハンドずつ計算で確かめられます。統計は仕組みが正しく動いていることの補足です。</p>
    <p class="muted">計算時間 ${s.seconds.toFixed(1)} 秒。</p>
  </section>
</div>`;
}
