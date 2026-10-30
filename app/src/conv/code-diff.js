'use strict';
/**
 * 「某一轮改了哪些代码」—— 组装界面要的那份数据。
 *
 * 这一层只管两件事：**读盘**（怎么读、去哪儿读）和**组装**（输出长什么样），
 * 怎么回放、怎么算行号、什么情况下算不准，全在 code-state.js 里。
 *
 * 行号的来历：
 *   删除行的行号 = 它在「这一轮之前」那份文件里的位置
 *   新增行的行号 = 它在「这一轮之后」那份文件里的位置
 * 两份内容都是把日志里的改动回放出来的，不是拿磁盘上那份硬凑的。
 */

const { readTextFileIfExists } = require('../text-file');
const { relativeTo } = require('../paths');
const { roundChanges } = require('./code-state');

/**
 * 算出第 index 轮改了哪些代码
 *
 * @param {Object} p
 * @param {Array} p.rounds 解析出来的所有轮次（每轮带 edits）
 * @param {string} p.cwd 项目目录（用来把绝对路径变成相对路径）
 * @param {number} p.index 要算第几轮（从 1 开始）
 * @returns {Promise<{index:number, cwd:string, total:number, files:Array}>}
 */
async function roundCode({ rounds, cwd, index }) {
  const round = (rounds || []).find((r) => r.index === index);
  if (!round) throw new Error(`日志里找不到第 ${index} 轮`);

  const projectDir = cwd || '';
  // 一趟扫完，把所有改动按文件归堆（不用每个文件重扫一遍所有轮次）
  const byFile = groupEditsByFile(rounds);

  const files = await Promise.all(
    touchedFiles(round).map(async (file) => {
      const { exists, content } = await readTextFileIfExists(file);
      const r = roundChanges({
        edits: byFile.get(file) || [],
        targetRound: index,
        diskContent: content,
      });
      return {
        file,
        rel: relativeTo(projectDir, file),
        exists,
        changes: r.changes,
        beforeLines: r.beforeLines,
        afterLines: r.afterLines,
        approx: r.approx,
        note: r.note || '',
      };
    })
  );

  return { index, cwd: projectDir, total: files.length, files };
}

/** 把所有轮次的改动按文件归堆 */
function groupEditsByFile(rounds) {
  const byFile = new Map();
  for (const r of rounds || []) {
    for (const e of r.edits || []) {
      const file = String(e.file || '');
      if (!file) continue;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push({
        round: r.index,
        kind: e.kind,
        oldText: e.oldText,
        newText: e.newText,
      });
    }
  }
  return byFile;
}

/** 这一轮碰过哪些文件（按日志里的先后，不重复） */
function touchedFiles(round) {
  const out = [];
  for (const e of round.edits || []) {
    const f = String(e.file || '');
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

module.exports = { roundCode };
