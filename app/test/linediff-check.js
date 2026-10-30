'use strict';
/**
 * linediff 的自测脚本：node app/test/linediff-check.js
 * 纯 Node，不依赖 electron、不联网。
 */

const path = require('path');
const { splitLines, diffLines } = require(path.join(__dirname, '..', 'src', 'conv', 'linediff.js'));

let fails = 0;
let passes = 0;

/** 比较两个值（结构化比较），失败时打印期望与实际 */
function eq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passes++;
    console.log(`PASS  ${name}`);
  } else {
    fails++;
    console.log(`FAIL  ${name}  期望=${b}  实际=${a}`);
  }
}

/**
 * 布尔断言：条件为真打印 PASS，否则打印 FAIL。
 * 可选 detail 只用于把实测数字打出来给人看，不影响判定。
 */
function ok(cond, name, detail, expected, actual) {
  if (cond) {
    passes++;
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    fails++;
    console.log(`FAIL  ${name}  期望=${expected || 'true'}  实际=${actual || 'false'}`);
  }
}

/* ---------------- splitLines ---------------- */

eq(splitLines(''), [], 'splitLines: 空串 -> []');
eq(splitLines('a'), ['a'], 'splitLines: 单行 -> ["a"]');
eq(splitLines('a\nb\n'), ['a', 'b'], 'splitLines: 末尾换行不算多出来的一行');
eq(splitLines('a\nb'), ['a', 'b'], 'splitLines: 无末尾换行');
eq(splitLines('a\r\nb'), ['a', 'b'], 'splitLines: CRLF 也切');
eq(splitLines('a  \nb'), ['a  ', 'b'], 'splitLines: 行尾空格保留');
eq(splitLines('\n'), [], 'splitLines: 只有一个换行 -> []');
eq(splitLines(null), [], 'splitLines: null -> []');
eq(splitLines(undefined), [], 'splitLines: undefined -> []');
eq(splitLines('a\nb\r\nc'), ['a', 'b', 'c'], 'splitLines: 混合换行');

/* ---------------- diffLines ---------------- */

eq(diffLines('a\nb\n', 'a\nb\n'), [], 'diffLines: 完全相同 -> []');
eq(diffLines('', ''), [], 'diffLines: 两边都空 -> []');

eq(
  diffLines('a\nb\nc\n', 'a\nX\nc\n'),
  [{ removed: [{ line: 2, text: 'b' }], added: [{ line: 2, text: 'X' }] }],
  'diffLines: 单行替换 -> 一个 hunk，removed line=2 / added line=2'
);

eq(
  diffLines('a\nb\nc\n', 'a\nc\n'),
  [{ removed: [{ line: 2, text: 'b' }], added: [] }],
  'diffLines: 纯删除一行 -> 只有 removed'
);

eq(
  diffLines('a\nb\nc\n', 'a\nX\nb\nc\n'),
  [{ removed: [], added: [{ line: 2, text: 'X' }] }],
  'diffLines: 中间纯新增一行 -> 只有 added，行号指向新版本'
);

eq(
  diffLines('', 'a\nb\n'),
  [{ removed: [], added: [{ line: 1, text: 'a' }, { line: 2, text: 'b' }] }],
  'diffLines: 空 -> 非空 -> 全部 added，行号 1..n'
);

eq(
  diffLines('a\nb\n', ''),
  [{ removed: [{ line: 1, text: 'a' }, { line: 2, text: 'b' }], added: [] }],
  'diffLines: 非空 -> 空 -> 全部 removed，行号 1..n'
);

eq(
  diffLines('1\n2\n3\n4\n5\n', '1\nX\n3\nY\n5\n'),
  [
    { removed: [{ line: 2, text: '2' }], added: [{ line: 2, text: 'X' }] },
    { removed: [{ line: 4, text: '4' }], added: [{ line: 4, text: 'Y' }] },
  ],
  'diffLines: 两处不相邻的修改 -> 两个 hunk'
);

eq(
  diffLines('b\nc\n', 'a\nb\nc\n'),
  [{ removed: [], added: [{ line: 1, text: 'a' }] }],
  'diffLines: 首行插入 -> added 的 line 从 1 开始'
);

eq(
  diffLines('a\nb\n', 'a\nb\nc\n'),
  [{ removed: [], added: [{ line: 3, text: 'c' }] }],
  'diffLines: 末尾追加 -> 只有 added，行号接在后面'
);

eq(
  diffLines('a  \nb\n', 'a\nb\n'),
  [{ removed: [{ line: 1, text: 'a  ' }], added: [{ line: 1, text: 'a' }] }],
  'diffLines: 行尾空格不同也算变化（不能 trim 掉）'
);

eq(
  diffLines('a\tb\n', 'a b\n'),
  [{ removed: [{ line: 1, text: 'a\tb' }], added: [{ line: 1, text: 'a b' }] }],
  'diffLines: 制表符 vs 空格也算变化'
);

eq(
  diffLines('a\nb\nc\n', 'c\na\nb\n'),
  [
    { removed: [], added: [{ line: 1, text: 'c' }] },
    { removed: [{ line: 3, text: 'c' }], added: [] },
  ],
  'diffLines: 整体重排 -> 如实报告为变化（LCS 对齐后是两处改动）'
);

/* ---------------- 大文件（退化路径） ---------------- */

const bigOld = Array.from({ length: 3500 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const bigNewLines = Array.from({ length: 3500 }, (_, i) => `line ${i + 1}`);
bigNewLines[1999] = 'line 2000 (改了)';
const bigNew = bigNewLines.join('\n') + '\n';

const bigHunks = diffLines(bigOld, bigNew);
eq(bigHunks.length, 1, '大文件: 3500 行改一行 -> 不崩，只出一个 hunk');
eq(
  bigHunks[0] && bigHunks[0].removed,
  [{ line: 2000, text: 'line 2000' }],
  '大文件: removed 行号正确'
);
eq(
  bigHunks[0] && bigHunks[0].added,
  [{ line: 2000, text: 'line 2000 (改了)' }],
  '大文件: added 行号正确'
);
eq(diffLines(bigOld, bigOld), [], '大文件: 两边相同 -> []');

/* ---------------- 不对称大文件：内存护栏 ---------------- */

/** 生成 n 行「第 i 行」文本的数组 */
function makeLines(n) {
  const arr = new Array(n);
  for (let i = 0; i < n; i++) arr[i] = `line ${i + 1}`;
  return arr;
}

/** 行数组拼成文本（带结尾换行） */
function joinLines(arr) {
  return arr.join('\n') + '\n';
}

/**
 * 跑一次 diff，顺带记录耗时与 rss 变化。
 * 输入文本在测量前就准备好，所以 rss 差值主要反映 diff 自身的开销。
 */
function runDiff(oldText, newText) {
  const rssBefore = process.memoryUsage().rss;
  const t0 = process.hrtime.bigint();
  let hunks = null;
  let err = null;
  try {
    hunks = diffLines(oldText, newText);
  } catch (e) {
    err = e;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const rssAfter = process.memoryUsage().rss;
  return {
    hunks,
    err,
    ms,
    rssDeltaMB: (rssAfter - rssBefore) / (1024 * 1024),
  };
}

/**
 * 用例 1：old 3000 行 / new 60000 行（不对称）。
 * 旧护栏要求「两边都超过 3000 行」才退化，所以这里会走全量 DP，
 * Int32Array 需要 3001×60001×4 ≈ 687 MB，把主进程卡死。
 * 新护栏按乘积卡，因此应该走退化路径，内存平稳。
 */
{
  const oldText = joinLines(makeLines(3000));
  const newText = joinLines(makeLines(60000));
  const r = runDiff(oldText, newText);

  console.log(
    `      不对称 3000×60000: 耗时=${r.ms.toFixed(1)}ms  rss 增长=${r.rssDeltaMB.toFixed(1)}MB`
  );
  ok(!r.err, '不对称大文件(3000×60000): 不抛异常', r.err ? String(r.err) : '无异常', '无异常', r.err ? String(r.err) : '无异常');
  ok(
    Array.isArray(r.hunks) && r.hunks.length === 1,
    '不对称大文件(3000×60000): 返回一个 hunk',
    `hunks=${r.hunks ? r.hunks.length : 'null'}`,
    '1',
    String(r.hunks ? r.hunks.length : 'null')
  );
  ok(
    r.hunks && r.hunks[0].removed.length === 0,
    '不对称大文件(3000×60000): old 全是 new 的前缀，removed 为空',
    `removed=${r.hunks ? r.hunks[0].removed.length : 'null'}`,
    '0',
    String(r.hunks ? r.hunks[0].removed.length : 'null')
  );
  ok(
    r.hunks && r.hunks[0].added.length === 57000 && r.hunks[0].added[0].line === 3001 &&
      r.hunks[0].added[56999].line === 60000,
    '不对称大文件(3000×60000): added 行号接在新文本后面（3001..60000）',
    `added=${r.hunks ? r.hunks[0].added.length : 'null'}`,
    '57000 行，3001..60000',
    String(r.hunks ? r.hunks[0].added.length : 'null')
  );
  ok(
    r.rssDeltaMB < 300,
    '不对称大文件(3000×60000): rss 增长 < 300MB',
    `${r.rssDeltaMB.toFixed(1)}MB`,
    '<300MB',
    `${r.rssDeltaMB.toFixed(1)}MB`
  );
}

/**
 * 用例 2：更极端的不对称 old 3000 行 / new 200000 行。
 * 旧护栏下这是 3001×200001×4 ≈ 2.4 GB 的 Int32Array，直接 RangeError 或被系统杀掉。
 */
{
  const oldText = joinLines(makeLines(3000));
  const newText = joinLines(makeLines(200000));
  const r = runDiff(oldText, newText);

  console.log(
    `      不对称 3000×200000: 耗时=${r.ms.toFixed(1)}ms  rss 增长=${r.rssDeltaMB.toFixed(1)}MB`
  );
  ok(!r.err, '不对称大文件(3000×200000): 不抛异常', r.err ? String(r.err) : '无异常', '无异常', r.err ? String(r.err) : '无异常');
  ok(
    Array.isArray(r.hunks) && r.hunks.length === 1,
    '不对称大文件(3000×200000): 返回一个 hunk',
    `hunks=${r.hunks ? r.hunks.length : 'null'}`,
    '1',
    String(r.hunks ? r.hunks.length : 'null')
  );
  ok(
    r.hunks && r.hunks[0].added.length === 197000,
    '不对称大文件(3000×200000): added 共 197000 行',
    `added=${r.hunks ? r.hunks[0].added.length : 'null'}`,
    '197000',
    String(r.hunks ? r.hunks[0].added.length : 'null')
  );
  ok(
    r.rssDeltaMB < 300,
    '不对称大文件(3000×200000): rss 增长 < 300MB',
    `${r.rssDeltaMB.toFixed(1)}MB`,
    '<300MB',
    `${r.rssDeltaMB.toFixed(1)}MB`
  );
}

/**
 * 用例 3：退化路径的行号仍然正确。
 * old 5000 行（第 10 行是旧内容），new 5001 行（第 10 行被拆成两行）。
 * 期望：removed 的 line = 10；added 的 line = 10 和 11。
 */
{
  const oldLines = makeLines(5000);
  oldLines[9] = 'line 10 (old)';
  const newLines = makeLines(5000);
  newLines[9] = 'line 10 (new a)';
  newLines.splice(10, 0, 'line 10 (new b)');

  const hunks = diffLines(joinLines(oldLines), joinLines(newLines));
  const h = hunks[0];
  ok(
    hunks.length === 1 && h.removed.length === 1 && h.removed[0].line === 10,
    '退化路径行号: removed 的 line = 10',
    `removed=${JSON.stringify(h ? h.removed : null)}`,
    '[{"line":10,...}]',
    JSON.stringify(h ? h.removed : null)
  );
  ok(
    hunks.length === 1 && h.added.length === 2 && h.added[0].line === 10 && h.added[1].line === 11,
    '退化路径行号: added 的 line = 10 和 11',
    `added=${JSON.stringify(h ? h.added : null)}`,
    '[{"line":10,...},{"line":11,...}]',
    JSON.stringify(h ? h.added : null)
  );
}

/**
 * 用例 4：两边都超限（各 5000 行）也走退化路径，且行号正确。
 * 中间第 2500 行改了。
 */
{
  const oldLines = makeLines(5000);
  const newLines = makeLines(5000);
  oldLines[2499] = 'line 2500 (old)';
  newLines[2499] = 'line 2500 (new)';

  const hunks = diffLines(joinLines(oldLines), joinLines(newLines));
  const h = hunks[0];
  ok(
    hunks.length === 1 && h.removed.length === 1 && h.removed[0].line === 2500,
    '两边都超限: removed 的 line = 2500',
    `removed=${JSON.stringify(h ? h.removed : null)}`,
    '[{"line":2500,...}]',
    JSON.stringify(h ? h.removed : null)
  );
  ok(
    hunks.length === 1 && h.added.length === 1 && h.added[0].line === 2500,
    '两边都超限: added 的 line = 2500',
    `added=${JSON.stringify(h ? h.added : null)}`,
    '[{"line":2500,...}]',
    JSON.stringify(h ? h.added : null)
  );
}

/**
 * 用例 5（附加）：确认超限时确实走的是「整块替换」退化路径，而不是全量 DP。
 * 两处相隔很远的改动：全量 DP 会切成两个 hunk，退化路径会合并成一整块。
 */
{
  const oldLines = makeLines(5000);
  const newLines = makeLines(5000);
  oldLines[99] = 'line 100 (old)';
  oldLines[3999] = 'line 4000 (old)';
  newLines[99] = 'line 100 (new)';
  newLines[3999] = 'line 4000 (new)';

  const hunks = diffLines(joinLines(oldLines), joinLines(newLines));
  const h = hunks[0];
  ok(
    hunks.length === 1,
    '超限走退化路径: 两处远隔的改动合并成一个 hunk（DP 会切成两个）',
    `hunks=${hunks.length}`,
    '1',
    String(hunks.length)
  );
  ok(
    h && h.removed.length === 3901 && h.removed[0].line === 100 && h.removed[3900].line === 4000,
    '超限走退化路径: 整块删除的行号是旧文本真实行号（100..4000）',
    `removed=${h ? JSON.stringify([h.removed.length, h.removed[0], h.removed[3900]]) : 'null'}`,
    '[3901,{"line":100},{"line":4000}]',
    h ? JSON.stringify([h.removed.length, h.removed[0], h.removed[3900]]) : 'null'
  );
  ok(
    h && h.added.length === 3901 && h.added[0].line === 100 && h.added[3900].line === 4000,
    '超限走退化路径: 整块新增的行号是新文本真实行号（100..4000）',
    `added=${h ? JSON.stringify([h.added.length, h.added[0], h.added[3900]]) : 'null'}`,
    '[3901,{"line":100},{"line":4000}]',
    h ? JSON.stringify([h.added.length, h.added[0], h.added[3900]]) : 'null'
  );
}

/* ---------------- 结果结构自检 ---------------- */

const shape = diffLines('a\nb\nc\n', 'a\nX\nc\n');
eq(
  Object.keys(shape[0]).sort(),
  ['added', 'removed'],
  '结构: hunk 只有 removed / added 两个键'
);
eq(
  Object.keys(shape[0].removed[0]).sort(),
  ['line', 'text'],
  '结构: 行项只有 line / text 两个键'
);

/* ---------------- 汇总 ---------------- */

console.log(`\n共 ${passes + fails} 条，PASS ${passes} 条，FAIL ${fails} 条`);
if (fails > 0) process.exit(1);
process.exit(0);
