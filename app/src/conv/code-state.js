'use strict';
/**
 * 从日志里的改动，回放出「某一轮之前」和「那一轮之后」的文件内容，
 * 再算出这一轮改了哪些行、行号是多少。
 *
 * 日志里记的是**改动的文本**，不是行号；行号得从文件内容里算。
 * 麻烦在于磁盘上那份文件可能是好几轮之后的样子 —— 直接拿它算会算错，
 * 甚至文本根本找不着（那一列就空了）。
 *
 * 回放有两条路：
 *  A. 目标轮之前有过 Write → 从那次 Write 的内容**正着**回放到目标轮（精确）
 *  B. 没有 Write → 从磁盘上的最终内容**倒着**撤到目标轮（精确）
 * 撤不动的时候退回「按当前文件估算」，并说明为什么撤不动（note）。
 *
 * 一条贯穿全文件的约定：
 *  - 行号分两个版本算：**删除行是「改前」那份文件里的行号，新增行是「改后」那份里的**；
 *  - 只要有一处位置说不准（同一段文字在文件里出现多次），就标 approx，不装作精确；
 *  - 目标轮本身就是那次 Write 时，「改前」按「文件本来不存在」算（这是唯一的假设，
 *    日志里看不出来文件在那之前有没有内容），「改后」是日志里写的内容，精确。
 *
 * 这一层是纯计算：不碰磁盘、不管界面长什么样。
 */

const { splitLines, diffLines } = require('./linediff');

/** 撤不动 / 算不准的原因 → 给用户看的一句话 */
const REASONS = {
  'no-anchor': '这一轮之前的内容推不出来（找不到能确定内容的锚点）',
  'write-later': '文件后来被整个改写过，这一轮之前的内容推不出来',
  'write-in-round': '这一轮里把整个文件重写了，改之前的内容推不出来',
  deleted: '这一轮删掉了内容，删之前的样子推不出来',
  notebook: '这一轮改的是 notebook，内容没法按行算',
  mismatch: '磁盘上的内容跟日志对不上（文件后来在别处被改过）',
  ambiguous: '改动的那段文字在文件里不唯一，位置可能对不上',
};

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

/** oldText 在 content 里出现的位置和次数 */
function findOccurrence(content, needle) {
  if (!needle) return { index: -1, count: 0 };
  let count = 0;
  let index = -1;
  let from = 0;
  for (;;) {
    const i = content.indexOf(needle, from);
    if (i < 0) break;
    if (index < 0) index = i;
    count++;
    from = i + needle.length;
  }
  return { index, count };
}

/**
 * 把 oldText 换成 newText（换第一处）
 * @returns {{content:string, count:number}|null} count > 1 说明这段文字不唯一
 */
function applyReplace(content, oldText, newText) {
  if (!oldText) return null;
  const { index, count } = findOccurrence(content, oldText);
  if (index < 0) return null;
  return {
    content: content.slice(0, index) + newText + content.slice(index + oldText.length),
    count,
  };
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

/**
 * 把一轮里的几个改动作用在内容上
 *
 * 一组里只要有 Write，就以它为准（它整个替换了文件），
 * 只把它**后面**的改动再作用上去 —— 前面那些被覆盖了，不算数。
 *
 * @returns {{content:string|null, reason:string, ambiguous:boolean}}
 */
function applyEdits(content, edits) {
  const writeIdx = edits.findIndex((e) => e.kind === 'write');
  let cur;
  let startIdx = 0;

  if (writeIdx >= 0) {
    cur = String(edits[writeIdx].newText == null ? '' : edits[writeIdx].newText);
    startIdx = writeIdx + 1;
  } else {
    if (content === null) return { content: null, reason: 'no-anchor', ambiguous: false };
    cur = content;
  }

  let ambiguous = false;
  for (let i = startIdx; i < edits.length; i++) {
    const e = edits[i];
    if (e.kind === 'notebook') return { content: null, reason: 'notebook', ambiguous };
    const r = applyReplace(cur, e.oldText, e.newText);
    if (r === null) {
      // oldText 找不到：可能这次改动已经被别的改动覆盖了。
      // 若 newText 还在，说明改动已经体现在内容里了，内容不变。
      if (e.newText && cur.indexOf(e.newText) >= 0) continue;
      return { content: null, reason: 'mismatch', ambiguous };
    }
    if (r.count > 1) ambiguous = true; // 这段文字不唯一，替换的位置可能对不上
    cur = r.content;
  }

  return { content: cur, reason: '', ambiguous };
}

/**
 * 把一轮里的几个改动撤掉（倒着撤：先撤最后一个）
 *
 * 唯一性检查（ambiguous）两边都要做：
 * - 撤的时候找的是 newText，它在当前内容里出现多次 → 撤的可能不是原来改的那一处；
 * - 撤回去之后，oldText 在「改之前」那份内容里出现多次 → 这次改动本来就定位不准。
 * 任何一条成立都不能装作精确。
 *
 * @param {string} content 当前内容
 * @param {Array} edits 这一轮的改动
 * @param {boolean} isTarget 撤的是不是目标轮自己（决定 Write 的原因写哪个）
 * @returns {{content:string|null, reason:string, ambiguous:boolean}}
 */
function undoEdits(content, edits, isTarget) {
  let cur = content;
  let ambiguous = false;

  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    if (e.kind === 'write') {
      // 整个文件被替换过，撤不回来
      return {
        content: null,
        reason: isTarget ? 'write-in-round' : 'write-later',
        ambiguous,
      };
    }
    if (e.kind === 'notebook') return { content: null, reason: 'notebook', ambiguous };
    if (!e.newText) return { content: null, reason: 'deleted', ambiguous }; // 删掉了内容，撤不回来（不知道删在哪儿）

    const r = applyReplace(cur, e.newText, e.oldText);
    if (r === null) {
      // newText 不在了，但 oldText 在 → 说明这次改动没落盘（文件还是老的），内容不变
      if (e.oldText && cur.indexOf(e.oldText) >= 0) continue;
      return { content: null, reason: 'mismatch', ambiguous };
    }
    if (r.count > 1) ambiguous = true; // 撤回去的那段文字在文件里不唯一 → 撤的位置可能不对
    cur = r.content;

    // oldText 在「改之前」那份内容里出现多次 → 这次改动在文件里本来就不唯一
    if (e.oldText && findOccurrence(cur, e.oldText).count > 1) ambiguous = true;
  }

  return { content: cur, reason: '', ambiguous };
}

/** 目标轮之前、最后一次带 Write 的那一轮 */
function lastWriteBefore(groups, targetRound) {
  let found = null;
  for (const g of groups) {
    if (g.round > targetRound) break;
    if (g.edits.some((e) => e.kind === 'write')) found = g;
  }
  return found;
}

/** 从锚点那一轮正着回放到目标轮 */
function replayForward(groups, anchorRound, targetRound) {
  let content = null;
  for (const g of groups) {
    if (g.round < anchorRound) continue;
    if (g.round > targetRound) break;

    const before = content;
    const startsWithWrite = g.edits[0] && g.edits[0].kind === 'write';
    const applied = applyEdits(content, g.edits);

    if (applied.content === null) {
      return { before: null, after: null, reason: applied.reason || 'mismatch' };
    }
    if (g.round === targetRound) {
      // 这一轮是 Write 起的头 → 这一轮之前按「文件本来不存在」算（唯一的假设）
      const beforeContent = before === null ? (startsWithWrite ? '' : null) : before;
      return {
        before: beforeContent,
        after: applied.content,
        reason: applied.ambiguous ? 'ambiguous' : '',
      };
    }
    content = applied.content;
  }
  return { before: null, after: null, reason: 'no-anchor' };
}

/** 从磁盘上的最终内容倒着撤到目标轮 */
function replayBackward(groups, targetRound, disk) {
  let content = disk;
  let ambiguous = false;

  // 先撤掉目标轮**之后**的改动 → 得到「这一轮之后」的内容
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g.round <= targetRound) break;
    const r = undoEdits(content, g.edits, false);
    if (r.content === null) return { before: null, after: null, reason: r.reason, ambiguous: r.ambiguous };
    ambiguous = ambiguous || r.ambiguous;
    content = r.content;
  }

  const after = content;
  const target = groups.find((g) => g.round === targetRound);
  const b = undoEdits(content, target.edits, true);
  if (b.content === null) {
    return { before: null, after, reason: b.reason, ambiguous: ambiguous || b.ambiguous };
  }
  return {
    before: b.content,
    after,
    reason: ambiguous || b.ambiguous ? 'ambiguous' : '',
    ambiguous: ambiguous || b.ambiguous,
  };
}

/**
 * 算某一轮改了哪些代码
 *
 * 两条精确路径，谁先谁后有讲究：
 *  A. 正着回放（目标轮之前有过 Write）—— 纯靠日志推出来，反映的是「agent 当时干了什么」，
 *     文件后来被谁在别处改过都不影响；
 *  B. 倒着撤（从磁盘上的最终内容退回来）—— 锚在真实的磁盘内容上，日志里没有锚点时用它。
 *
 * 两条都拿不到「改前 / 改后」两版内容时，退回「按当前文件估算」，并说清为什么。
 *
 * @param {Object} p
 * @param {Array} p.edits 这个文件在整份日志里的所有改动：
 *   [{round, kind:'write'|'edit'|'notebook', oldText, newText}]，按日志顺序
 * @param {number} p.targetRound 要算第几轮
 * @param {string} p.diskContent 磁盘上这个文件现在的内容（读不到就是空串）
 * @returns {{changes:Array, beforeLines:number|null, afterLines:number|null,
 *            approx:boolean, note:string}}
 */
function roundChanges({ edits, targetRound, diskContent }) {
  const groups = groupByRound(edits);
  const disk = diskContent == null ? '' : String(diskContent);
  const target = groups.find((g) => g.round === targetRound);
  if (!target) {
    return { changes: [], beforeLines: null, afterLines: null, approx: true, note: REASONS['no-anchor'] };
  }

  // A. 正着回放：目标轮之前有过 Write
  const anchor = lastWriteBefore(groups, targetRound);
  const fwd = anchor
    ? replayForward(groups, anchor.round, targetRound)
    : { before: null, after: null, reason: 'no-anchor' };
  if (fwd.before !== null && fwd.after !== null) {
    return exact(fwd.before, fwd.after, fwd.reason);
  }

  // B. 倒着撤：从磁盘上的最终内容退回来
  const back = replayBackward(groups, targetRound, disk);
  if (back.before !== null && back.after !== null) {
    return exact(back.before, back.after, back.reason);
  }

  // 撤不动：按当前文件估算，并说清为什么
  const reason = back.reason || fwd.reason || 'no-anchor';
  const afterText = back.after !== null ? back.after : (fwd.after !== null ? fwd.after : disk);
  return {
    changes: estimateChanges(target.edits, disk),
    beforeLines: null,
    afterLines: splitLines(afterText).length,
    approx: true,
    note: REASONS[reason] || REASONS['no-anchor'],
  };
}

/** 两个版本都拿到了 → 直接 diff，行号是各自版本里的真实行号 */
function exact(before, after, reason) {
  return {
    changes: diffLines(before, after),
    beforeLines: splitLines(before).length,
    afterLines: splitLines(after).length,
    approx: !!reason,
    note: reason ? REASONS[reason] || '' : '',
  };
}

/**
 * 撤不动时的兜底：按当前磁盘上的文件估算行号
 *
 * 删除的行和新增的行**各找各的** —— 找不到就留空，
 * 绝不拿新增行的位置冒充删除行的位置。
 */
function estimateChanges(edits, disk) {
  const changes = [];
  for (const e of edits || []) {
    if (e.kind === 'write') {
      changes.push({
        removed: [],
        added: splitLines(e.newText).map((t, i) => ({ line: i + 1, text: t })),
      });
      continue;
    }
    if (e.kind === 'notebook') {
      changes.push({
        removed: [],
        added: splitLines(e.newText).map((t) => ({ line: null, text: t })),
      });
      continue;
    }
    const addedAt = findStartLine(disk, e.newText);
    const removedAt = findStartLine(disk, e.oldText);
    changes.push({
      removed: splitLines(e.oldText).map((t, i) => ({ line: removedAt === null ? null : removedAt + i, text: t })),
      added: splitLines(e.newText).map((t, i) => ({ line: addedAt === null ? null : addedAt + i, text: t })),
    });
  }
  return changes;
}

module.exports = { roundChanges, REASONS };
