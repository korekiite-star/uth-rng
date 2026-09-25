/**
 * アプリの検算（TypeScript）と、独立した Python 実装（apps/web/public/verify_hand.py。アプリから /verify_hand.py でダウンロードできる）が同じ山札を出すか。
 * Python が無い環境ではスキップする。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitOf, verifyFair } from '../src/index.js';

const script = join(__dirname, '../../../apps/web/public/verify_hand.py');
const hasPython = (() => {
  try {
    execFileSync('python', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPython)('Python の独立実装と一致', () => {
  it('同じシードから同じ山札・配札', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uth-fair-'));
    for (let n = 0; n < 5; n++) {
      const serverSeed = `server-${n}-` + 'ab'.repeat(20);
      const rec = {
        handNo: 100 + n,
        commit: commitOf(serverSeed),
        serverSeed,
        clientSeeds: { 'g:222': `seed${n}b`, 'g:111': `seed${n}a`, 'bot-x': 'zz' },
        order: ['g:222', 'bot-x', 'g:111'],
      };
      const file = join(dir, `h${n}.json`);
      writeFileSync(file, JSON.stringify(rec));
      const out = execFileSync('python', [script, file], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      const deckLine = out.split(/\r?\n/).find((l) => l.startsWith('山札:'))!;
      expect(deckLine.replace('山札:', '').trim().split(' ')).toEqual(verifyFair(rec).deck);
      expect(out).toContain('コミット一致: OK');
    }
  });
});
