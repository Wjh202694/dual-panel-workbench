'use strict';
/**
 * 回放算法（code-state.js）的自测脚本：node app/test/code-state-check.js
 *
 * 纯 Node（CommonJS），不依赖 electron、不联网、只读被测模块。
 *
 * 语义（跟 code-state.js 的文档对齐）：
 *   - removed[].line = 这一行在「改之前」那份文件里的行号（1 起）
 *   - added[].line   = 这一行在「改之后」那份文件里的行号（1 起）
 *   - approx === false 时 note 为空串；approx === true 时 note 是一句中文原因
 */

const path = require('path');
const {
  roundChanges,
  REASONS,
} = require(path.join(__dirname, '..', 'src', 'conv', 'code-state.js'));

/* ---------------- 迷你断言框架 ---------------- */

let fails = 0;
let passes = 0;

/** 结构化比较（JSON），失败时打印期望与实际 */
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
 * 布尔断言：条件为真打印 PASS，否则打印 FAIL 并 fails++。
 * detail 是给人看的实测数字（不参与判定），expected/actual 是失败时打印的说明。
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

/** 只打印，不参与判定 —— 用来把实测结果摊开给人核对 */
function diag(text) {
  console.log(`DIAG  ${text}`);
}

/** 把一个 hunk 数组里的所有 removed / added 摊平成一维数组 */
function flat(hunks, key) {
  const out = [];
  for (const h of hunks || []) {
    for (const it of h[key] || []) out.push(it);
  }
  return out;
}

/** note 是不是一句非空的中文 */
function isChineseNote(note) {
  return typeof note === 'string' && note.length > 0 && /[一-龥]/.test(note);
}

/* ---------------- 1. 新建文件（一轮里一个 Write） ---------------- */

{
  const edits = [{ round: 1, kind: 'write', oldText: '', newText: 'a\nb\nc\n' }];
  const r = roundChanges({ edits, targetRound: 1, diskContent: 'a\nb\nc\n' });

  eq(r.beforeLines, 0, '1 新建文件：改之前 0 行');
  eq(r.afterLines, 3, '1 新建文件：改之后 3 行');
  eq(r.approx, false, '1 新建文件：算得精确');
  eq(r.note, '', '1 新建文件：没有原因说明');
  eq(flat(r.changes, 'removed'), [], '1 新建文件：没有删除行');
  eq(
    flat(r.changes, 'added'),
    [
      { line: 1, text: 'a' },
      { line: 2, text: 'b' },
      { line: 3, text: 'c' },
    ],
    '1 新建文件：新增行 1/2/3'
  );
}

/* ---------------- 2. 改一个本来就存在的文件（一轮里一个 Edit） ---------------- */

{
  const edits = [{ round: 1, kind: 'edit', oldText: 'l3', newText: 'L3\nL3b' }];
  const r = roundChanges({
    edits,
    targetRound: 1,
    diskContent: 'l1\nl2\nL3\nL3b\nl4\nl5\n',
  });

  eq(r.beforeLines, 5, '2 改已有文件：改之前 5 行');
  eq(r.afterLines, 6, '2 改已有文件：改之后 6 行');
  eq(r.approx, false, '2 改已有文件：算得精确');
  eq(r.note, '', '2 改已有文件：没有原因说明');
  eq(flat(r.changes, 'removed'), [{ line: 3, text: 'l3' }], '2 改已有文件：删掉第 3 行 l3');
  eq(
    flat(r.changes, 'added'),
    [
      { line: 3, text: 'L3' },
      { line: 4, text: 'L3b' },
    ],
    '2 改已有文件：新增第 3、4 行'
  );
}

/* ---------------- 3. 同一个文件连续两轮，每一轮的行号都要对 ---------------- */

{
  const edits = [
    { round: 1, kind: 'edit', oldText: 'l3', newText: 'L3' },
    { round: 2, kind: 'edit', oldText: 'l5', newText: 'L5' },
  ];
  const diskContent = 'l1\nl2\nL3\nl4\nL5\n';

  const r1 = roundChanges({ edits, targetRound: 1, diskContent });
  diag(`场景3 第1轮 回放结果: ${JSON.stringify(r1.changes)}`);
  eq(r1.approx, false, '3 第 1 轮：算得精确');
  eq(r1.beforeLines, 5, '3 第 1 轮：改之前 5 行');
  eq(r1.afterLines, 5, '3 第 1 轮：改之后 5 行');
  eq(flat(r1.changes, 'removed'), [{ line: 3, text: 'l3' }], '3 第 1 轮：删掉第 3 行');
  eq(flat(r1.changes, 'added'), [{ line: 3, text: 'L3' }], '3 第 1 轮：新增第 3 行');

  const r2 = roundChanges({ edits, targetRound: 2, diskContent });
  diag(`场景3 第2轮 回放结果: ${JSON.stringify(r2.changes)}`);
  eq(r2.approx, false, '3 第 2 轮：算得精确');
  eq(r2.beforeLines, 5, '3 第 2 轮：改之前 5 行');
  eq(r2.afterLines, 5, '3 第 2 轮：改之后 5 行');
  eq(flat(r2.changes, 'removed'), [{ line: 5, text: 'l5' }], '3 第 2 轮：删掉第 5 行');
  eq(flat(r2.changes, 'added'), [{ line: 5, text: 'L5' }], '3 第 2 轮：新增第 5 行');
}

/* ---------------- 4.【回归】某一轮删掉了一行，不能把整个文件的历史打回「全都不知道」 ---------------- */

{
  const edits = [
    { round: 1, kind: 'edit', oldText: 'l3', newText: 'L3' },
    { round: 2, kind: 'edit', oldText: 'l4', newText: '' }, // 删掉一行
    { round: 3, kind: 'edit', oldText: 'l5', newText: 'L5' },
  ];
  const diskContent = 'l1\nl2\nL3\nL5\n'; // 第 2 轮把 l4 整行删掉了

  const r3 = roundChanges({ edits, targetRound: 3, diskContent });
  diag(`场景4 第3轮 回放结果: ${JSON.stringify(r3.changes)}`);
  // 关键：删除没有污染后面的轮次，第 3 轮仍然是精确的
  eq(r3.approx, false, '4 回归：第 3 轮（删除之后）仍然是精确的');
  eq(r3.note, '', '4 回归：第 3 轮没有原因说明');
  eq(r3.beforeLines, 4, '4 回归：第 3 轮改之前 4 行');
  eq(r3.afterLines, 4, '4 回归：第 3 轮改之后 4 行');
  // l4 被删掉之后 l5 顶到了第 4 行，所以行号是 4（不是 5）
  eq(flat(r3.changes, 'removed'), [{ line: 4, text: 'l5' }], '4 回归：第 3 轮删掉第 4 行 l5');
  eq(flat(r3.changes, 'added'), [{ line: 4, text: 'L5' }], '4 回归：第 3 轮新增第 4 行 L5');

  const r1 = roundChanges({ edits, targetRound: 1, diskContent });
  diag(`场景4 第1轮 回放结果: ${JSON.stringify(r1.changes)}`);
  // 删除之前的样子撤不回来 → 只能标 approx
  eq(r1.approx, true, '4 回归：第 1 轮撤不回来 → approx');
  ok(isChineseNote(r1.note), '4 回归：第 1 轮带一句非空的中文原因', r1.note, '非空中文 note', r1.note);
}

/* ---------------- 5.【回归】同一轮里 Edit 排在 Write 前面，Write 的内容要被用上 ---------------- */

{
  const edits = [
    { round: 1, kind: 'edit', oldText: 'x', newText: 'y' },
    { round: 1, kind: 'write', oldText: '', newText: 'brand new\n' },
  ];
  const r = roundChanges({ edits, targetRound: 1, diskContent: 'brand new\n' });
  diag(`场景5 回放结果: ${JSON.stringify(r)}`);

  eq(r.afterLines, 1, '5 回归：改之后 1 行（Write 的内容被用上了）');
  // 这一轮里有 Edit，说明文件在这一轮之前就存在 → 改前的内容推不出来 → 必须标 approx
  eq(r.approx, true, '5 回归：改前推不出来 → approx');
  eq(r.note, REASONS['write-in-round'], '5 回归：原因写「这一轮里把整个文件重写了」');
  eq(r.beforeLines, null, '5 回归：改之前的行数是 null（不是 0）');
  eq(
    flat(r.changes, 'added').filter((it) => it.text === 'brand new'),
    [{ line: 1, text: 'brand new' }],
    '5 回归：新增里有第 1 行 brand new'
  );
}

/* ---------------- 6.【回归】中间有一轮 NotebookEdit，不能把别的轮次也拖下水 ---------------- */

{
  const edits = [
    { round: 1, kind: 'edit', oldText: 'l3', newText: 'L3' },
    { round: 2, kind: 'notebook', oldText: '', newText: '{"cells":[]}' },
    { round: 3, kind: 'edit', oldText: 'l5', newText: 'L5' },
  ];
  const diskContent = 'l1\nl2\nL3\nl4\nL5\n';

  const r3 = roundChanges({ edits, targetRound: 3, diskContent });
  diag(`场景6 第3轮 回放结果: ${JSON.stringify(r3.changes)}`);
  // 第 3 轮在 notebook 之后，但 notebook 挡不住它 → 仍然是精确的
  eq(r3.approx, false, '6 回归：第 3 轮不受 notebook 影响，仍然精确');
  eq(r3.beforeLines, 5, '6 回归：第 3 轮改之前 5 行');
  eq(r3.afterLines, 5, '6 回归：第 3 轮改之后 5 行');
  eq(flat(r3.changes, 'removed'), [{ line: 5, text: 'l5' }], '6 回归：第 3 轮删掉第 5 行');
  eq(flat(r3.changes, 'added'), [{ line: 5, text: 'L5' }], '6 回归：第 3 轮新增第 5 行');

  const r1 = roundChanges({ edits, targetRound: 1, diskContent });
  diag(`场景6 第1轮 回放结果: ${JSON.stringify(r1)}`);
  // 第 1 轮自己的改动必须还在（没被 notebook / 第 3 轮污染）
  eq(r1.changes.length, 1, '6 回归：第 1 轮只有 1 个 hunk（没被别的轮次拖下水）');
  eq(
    flat(r1.changes, 'removed').map((it) => it.text),
    ['l3'],
    '6 回归：第 1 轮的删除行还是 l3'
  );
  eq(
    flat(r1.changes, 'added').map((it) => it.text),
    ['L3'],
    '6 回归：第 1 轮的新增行还是 L3'
  );
  ok(
    !JSON.stringify(r1.changes).includes('cells'),
    '6 回归：第 1 轮的结果里没有 notebook 的内容'
  );
  ok(
    !JSON.stringify(r1.changes).includes('L5'),
    '6 回归：第 1 轮的结果里没有第 3 轮的 L5'
  );
}

/* ---------------- 7.【回归】改动的那段文字在文件里不唯一 → 必须标成 approx ---------------- */

{
  const edits = [{ round: 1, kind: 'edit', oldText: '}', newText: '}X' }];
  const r = roundChanges({ edits, targetRound: 1, diskContent: 'a\n}X\nb\n}\n' });
  diag(`场景7 回放结果: ${JSON.stringify(r)}`);

  eq(r.approx, true, '7 回归：改动文字不唯一 → 必须标 approx');
  ok(isChineseNote(r.note), '7 回归：带一句非空的中文原因', r.note, '非空中文 note', r.note);
  ok(!!REASONS.ambiguous, '7 回归：REASONS 里有 ambiguous 这一条');
}

/* ---------------- 8.【回归】兜底估算时，删除行和新增行必须各找各的位置 ---------------- */

{
  // 第 2 轮把整个文件覆盖掉（磁盘内容里既有 L3 也有 l3，正好能看出两者位置不同）
  const edits = [
    { round: 1, kind: 'edit', oldText: 'l3', newText: 'L3' },
    { round: 2, kind: 'write', oldText: '', newText: 'L3\nl3\n' },
  ];
  const r = roundChanges({ edits, targetRound: 1, diskContent: 'L3\nl3\n' });
  diag(`场景8 回放结果: ${JSON.stringify(r)}`);

  eq(r.approx, true, '8 回归：撤不动 → approx');
  ok(isChineseNote(r.note), '8 回归：带一句非空的中文原因', r.note, '非空中文 note', r.note);

  const removed = flat(r.changes, 'removed');
  const added = flat(r.changes, 'added');
  ok(removed.length > 0 && added.length > 0, '8 回归：有删除行也有新增行');
  const rmLine = removed.length ? removed[0].line : null;
  const adLine = added.length ? added[0].line : null;
  ok(
    rmLine === null || adLine === null || rmLine !== adLine,
    '8 回归：删除行和新增行没有共用同一个行号',
    `removed.line=${rmLine} added.line=${adLine}`,
    '两个行号不同（或至少有一个是 null）',
    `removed.line=${rmLine} added.line=${adLine}`
  );
  ok(
    rmLine !== null && adLine !== null && rmLine !== adLine,
    '8 回归：兜底估算时删除行和新增行各找各的位置',
    `removed.line=${rmLine} added.line=${adLine}`,
    '两个都是数字且互不相同',
    `removed.line=${rmLine} added.line=${adLine}`
  );
}

/* ---------------- 9. 目标轮自己就是那次 Write → 改后是精确的 ---------------- */

{
  const edits = [
    { round: 1, kind: 'write', oldText: '', newText: 'a\nb\n' },
    { round: 2, kind: 'write', oldText: '', newText: 'c\n' },
  ];
  const r = roundChanges({ edits, targetRound: 1, diskContent: 'c\n' });
  diag(`场景9 回放结果: ${JSON.stringify(r)}`);

  // 第 1 轮自己就是那次 Write：改后的内容日志里写得明明白白（a、b 两行），
  // 后来被覆盖也不影响这一轮的行号 —— 所以仍然是精确的。
  // 「改前」按「文件本来不存在」算（日志里看不出在那之前有没有内容）。
  eq(r.approx, false, '9 回归：目标轮自己就是那次 Write → 行号精确');
  eq(r.note, '', '9 回归：没有原因说明');
  eq(r.beforeLines, 0, '9 回归：改之前按 0 行算');
  eq(r.afterLines, 2, '9 回归：改之后 2 行');
  eq(
    flat(r.changes, 'added'),
    [{ line: 1, text: 'a' }, { line: 2, text: 'b' }],
    '9 回归：新增的两行行号是 1、2'
  );

  // 补一个「后来被 Write 覆盖」真的会挡住回放的例子：第 1 轮是 Edit，第 2 轮才整体覆盖
  const edits2 = [
    { round: 1, kind: 'edit', oldText: 'l3', newText: 'L3' },
    { round: 2, kind: 'write', oldText: '', newText: 'c\n' },
  ];
  const r2 = roundChanges({ edits: edits2, targetRound: 1, diskContent: 'c\n' });
  diag(`场景9b 回放结果: ${JSON.stringify(r2)}`);
  eq(r2.approx, true, '9b 回归：后面整体覆盖过 → 前面那轮标 approx');
  ok(isChineseNote(r2.note), '9b 回归：带一句非空的中文原因', r2.note, '非空中文 note', r2.note);
  eq(r2.note, REASONS['write-later'], '9b 回归：原因就是 write-later');
}

/* ---------------- 10. 找不到那一轮 → 不炸，返回空 changes + approx ---------------- */

{
  const edits = [{ round: 1, kind: 'write', oldText: '', newText: 'a\n' }];
  const r = roundChanges({ edits, targetRound: 9, diskContent: 'a\n' });

  eq(r.changes, [], '10 找不到那一轮：changes 为空');
  eq(r.approx, true, '10 找不到那一轮：approx = true');
  eq(r.beforeLines, null, '10 找不到那一轮：beforeLines 是 null');
  eq(r.afterLines, null, '10 找不到那一轮：afterLines 是 null');
  ok(isChineseNote(r.note), '10 找不到那一轮：带一句非空的中文原因', r.note, '非空中文 note', r.note);
}

/* ---------------- 汇总 ---------------- */

console.log('');
console.log(`总计 ${passes + fails} 条断言：PASS ${passes}，FAIL ${fails}`);
if (fails > 0) {
  console.log('有断言没通过 → 退出码 1');
  process.exit(1);
}
console.log('全部通过 → 退出码 0');
