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
