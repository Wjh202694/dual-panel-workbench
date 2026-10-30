'use strict';
/**
 * 某一轮改代码时，文件在「这一轮之前」和「这一轮之后」各是什么样子。
 *
 * 日志里只记了「改了哪一段文本」，没记行号；行号得从文件内容里算出来。
 * 麻烦在于磁盘上那份文件可能是好几轮之后的样子 —— 直接拿它算行号会算错，
 * 甚至文本根本找不着（那一列就空了）。
 *
 * 做法：把这个文件在整份日志里出现过的所有改动按顺序**回放**一遍，
 * 得出每一轮之前 / 之后的内容，再拿这两个版本做行级 diff。
 *  - 文件是 Write 出来的：Write 的内容就是那会儿的完整内容，从那儿往后能精确回放；
 *    这一轮之前的内容无从得知（Write 本来就不记旧内容），按「新文件」处理。
 *  - 文件本来就在（整份日志里没有 Write）：拿磁盘上的最终内容倒着撤
 *    （把新文本换回旧文本），撤到头就是最初的样子，再正着回放。
 * 撤不动的（后来有一次 Write 把整个文件覆盖了）：那会儿的内容无从得知，
 * 这一轮退回「按当前文件估算」的粗略行号，并标上 approx。
 */

const { splitLines, diffLines } = require('./linediff');

/** 按轮次分组，组内保持日志里的先后顺序 */
function groupByRound(edits) {
  const map = new Map();
  for (const e of edits || []) {
    const round = Number(e.round) || 0;
    if (!map.has(round)) map.set(round, []);
    map.get(round).push(e);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([round, list]) => ({ round, edits: list }));
}

/** 把 oldText 换成 newText（只换第一处）；找不到就返回 null */
function replaceFirst(content, oldText, newText) {
  if (typeof oldText !== 'string' || !oldText) return null;
  if (typeof content !== 'string') return null;
  const idx = content.indexOf(oldText);
  if (idx < 0) return null;
  return content.slice(0, idx) + newText + content.slice(idx + oldText.length);
}

/**
 * 把一轮里的几个改动依次作用在内容上
 * @returns {string|null} 新的内容；null = 推不出来（内容已经不可知）
 */
function applyEdits(content, edits) {
  let cur = content;
  for (const e of edits) {
    if (e.kind === 'write') {
      // 整个文件被替换 —— 从这一刻起内容是确定的
      cur = String(e.newText == null ? '' : e.newText);
      continue;
    }
    if (cur === null) return null;
    if (e.kind === 'notebook') return null; // notebook 的内容没法按行回放
    const replaced = replaceFirst(cur, e.oldText, e.newText);
    if (replaced !== null) {
      cur = replaced;
      continue;
    }
    // oldText 找不到：可能这轮改动已经被别的改动覆盖了。
    // 若 newText 还在，说明这次改动已经体现在内容里了，内容不变。
    if (cur.indexOf(String(e.newText || '')) >= 0 && e.newText) continue;
    return null;
  }
  return cur;
}

/** 倒着撤：把每一处改动的新文本换回旧文本，退回到最初的样子 */
function undoAll(content, groups) {
  let cur = content;
  const all = [];
  for (const g of groups) all.push(...g.edits);
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    if (e.kind === 'write') return null; // 整个文件被覆盖过，撤不回去
    if (e.kind === 'notebook') return null;
    const reverted = replaceFirst(cur, e.newText, e.oldText);
    if (reverted !== null) {
      cur = reverted;
      continue;
    }
    // newText 不在了，但 oldText 在 → 说明这次改动没落盘（文件还是老的），内容不变
    if (e.oldText && cur.indexOf(e.oldText) >= 0) continue;
    return null;
  }
  return cur;
}

/**
 * 算出每一轮之前 / 之后，这个文件各是什么内容
 *
 * @param {Array} edits 这个文件在整份日志里的所有改动：
 *   [{round, kind:'write'|'edit'|'notebook', oldText, newText}]，按日志顺序
 * @param {string} diskContent 磁盘上这个文件现在的内容（读不到就是空串）
 * @returns {Map<number, {before:string, after:string}|null>} 轮次 → 两个版本的内容；
 *   null = 那一轮的内容推不出来
 */
function computeRoundStates(edits, diskContent) {
  const states = new Map();
  const groups = groupByRound(edits);
  if (!groups.length) return states;

  const disk = diskContent == null ? '' : String(diskContent);
  const hasWrite = groups.some((g) => g.edits.some((e) => e.kind === 'write'));

  if (!hasWrite) {
    // 文件本来就在：从最终内容倒撤到最初，再正着回放
    const initial = undoAll(disk, groups);
    let cur = initial;
    for (const g of groups) {
      const before = cur;
      const after = applyEdits(cur, g.edits);
      states.set(g.round, after === null ? null : { before: before == null ? '' : before, after, approx: false });
      cur = after;
    }
    return states;
  }

  // 有 Write：Write 之前的内容无从得知，那些轮次作废
  const wi = groups.findIndex((g) => g.edits.some((e) => e.kind === 'write'));
  let cur = null;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const before = cur;
    const after = applyEdits(cur, g.edits);
    if (after === null) {
      states.set(g.round, null);
      cur = null;
      continue;
    }
    // 这一组是 Write 起的头 → 这一轮之前是「文件还不存在」
    const startsWithWrite = g.edits[0] && g.edits[0].kind === 'write';
    const beforeKnown = before != null;
    states.set(g.round, {
      before: beforeKnown ? before : '',
      after,
      // 之前的内容不是「文件还不存在」而是「推不出来」→ 行号只能算个大概
      approx: !beforeKnown && !startsWithWrite,
    });
    cur = after;
  }
  // Write 之前的那些轮次：内容推不出来
  for (let i = 0; i < wi; i++) states.set(groups[i].round, null);
  return states;
}

/**
 * 兜底：内容推不出来的时候，按当前磁盘上的文件估算行号
 * （只能在当前文件里找到新文本时才算得准，找不到就留空）
 */
function fallbackChanges(edits, diskContent) {
  const disk = diskContent == null ? '' : String(diskContent);
  const changes = [];
  for (const e of edits || []) {
    if (e.kind === 'write') {
      changes.push({
        kind: 'write',
        removed: [],
        added: splitLines(e.newText).map((t, i) => ({ line: i + 1, text: t })),
      });
      continue;
    }
    if (e.kind === 'notebook') {
      changes.push({
        kind: 'notebook',
        removed: [],
        added: splitLines(e.newText).map((t) => ({ line: null, text: t })),
      });
      continue;
    }
    const start = findStartLine(disk, e.newText);
    changes.push({
      kind: 'edit',
      removed: splitLines(e.oldText).map((t, i) => ({ line: start === null ? null : start + i, text: t })),
      added: splitLines(e.newText).map((t, i) => ({ line: start === null ? null : start + i, text: t })),
    });
  }
  return changes;
}

/** 在文件内容里找 needle 第一次出现的行号（1 起）；找不到返回 null */
function findStartLine(content, needle) {
  if (!needle) return null;
  const idx = String(content || '').indexOf(needle);
  if (idx < 0) return null;
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

module.exports = { computeRoundStates, fallbackChanges, diffLines, splitLines, findStartLine };
