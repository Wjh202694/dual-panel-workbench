'use strict';
/**
 * 纯函数的行级 diff：把两段文本拆成行，再按行算出「删了哪些、加了哪些」。
 *
 * 特点：
 * - 行号是各自版本里的真实行号（old 用旧文本的行号，new 用新文本的行号）；
 * - 用 LCS（最长公共子序列）做比对，相同行原样保留，不做 trim 比较；
 * - 文本很大时退化成「公共前缀 + 公共后缀 + 中间整块替换」，避免 DP 撑爆内存。
 */

/** 超过这个行数（两边同时超过）就不做全量 LCS，退化成整块替换 */
const MAX_DP_LINES = 3000;

/**
 * 把文本切成行数组。
 *
 * - 按 `\r\n` 或 `\n` 切分；
 * - 末尾的换行只用来终止最后一行，不额外产生一行（"a\nb\n" -> ['a','b']）；
 * - 行尾空格 / 制表符原样保留（diff 必须精确比较，trim 会造成假相等）。
 *
 * @param {string} text 原始文本，null / undefined 视为空串
 * @returns {string[]} 行数组
 */
function splitLines(text) {
  if (text === null || text === undefined) text = '';
  if (typeof text !== 'string') text = String(text);

  let s = text;
  // 末尾的换行符只是「结束符」，剥掉它，剩下的空串代表没有任何行
  if (s.endsWith('\r\n')) s = s.slice(0, -2);
  else if (s.endsWith('\n')) s = s.slice(0, -1);
  if (s === '') return [];

  return s.split(/\r\n|\n/);
}

/**
 * 行级 diff。
 *
 * @param {string} oldText 旧文本
 * @param {string} newText 新文本
 * @returns {Array<{removed: Array<{line:number,text:string}>, added: Array<{line:number,text:string}>}>}
 *   hunk 数组；removed 的 line 是旧文本行号，added 的 line 是新文本行号
 */
function diffLines(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;

  if (n === 0 && m === 0) return [];

  // 性能护栏：两边都很大时不做全量 DP
  if (n > MAX_DP_LINES && m > MAX_DP_LINES) return diffByBlock(a, b);

  // dp[i * W + j] = a[i..] 与 b[j..] 的 LCS 长度
  const W = m + 1;
  const dp = new Int32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    const rowBase = i * W;
    const nextBase = (i + 1) * W;
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[rowBase + j] = dp[nextBase + j + 1] + 1;
      } else {
        const del = dp[nextBase + j]; // 删掉 a[i]
        const ins = dp[rowBase + j + 1]; // 加上 b[j]
        dp[rowBase + j] = del >= ins ? del : ins;
      }
    }
  }

  // 从 dp[0 * W + 0] 出发回溯，边走边切 hunk
  const hunks = [];
  let cur = null;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      // 这行没变：断开当前 hunk
      if (cur) {
        hunks.push(cur);
        cur = null;
      }
      i++;
      j++;
      continue;
    }
    const del = dp[(i + 1) * W + j];
    const ins = dp[i * W + (j + 1)];
    if (del >= ins) {
      // 优先走删除
      if (!cur) cur = { removed: [], added: [] };
      cur.removed.push({ line: i + 1, text: a[i] });
      i++;
    } else {
      if (!cur) cur = { removed: [], added: [] };
      cur.added.push({ line: j + 1, text: b[j] });
      j++;
    }
  }
  // 尾巴：剩下的 old 行都是删除，剩下的 new 行都是新增
  if (!cur) cur = { removed: [], added: [] };
  while (i < n) {
    cur.removed.push({ line: i + 1, text: a[i] });
    i++;
  }
  while (j < m) {
    cur.added.push({ line: j + 1, text: b[j] });
    j++;
  }
  if (cur.removed.length || cur.added.length) hunks.push(cur);

  return hunks;
}

/**
 * 退化路径：公共前缀 + 公共后缀 + 中间整块替换。
 * 行号仍然是各自版本里的真实行号。
 *
 * @param {string[]} a 旧行数组
 * @param {string[]} b 新行数组
 */
function diffByBlock(a, b) {
  const n = a.length;
  const m = b.length;

  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < n - prefix &&
    suffix < m - prefix &&
    a[n - 1 - suffix] === b[m - 1 - suffix]
  ) {
    suffix++;
  }

  const removed = [];
  const added = [];
  for (let k = prefix; k < n - suffix; k++) removed.push({ line: k + 1, text: a[k] });
  for (let k = prefix; k < m - suffix; k++) added.push({ line: k + 1, text: b[k] });

  if (!removed.length && !added.length) return [];
  return [{ removed, added }];
}

module.exports = {
  splitLines,
  diffLines,
};
