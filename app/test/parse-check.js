'use strict';
/**
 * 本地诊断工具：拿一份真实日志，统计解析出来的轮次和残留的系统噪音。
 * 只读本地文件，不联网、不外传。
 *
 * 用法： node test/parse-check.js [日志路径]
 * 不给路径时，自动挑 ~/.claude/projects 下最近修改过的那份。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseTranscript } = require('../src/conv/parse-log');

const dir = path.join(os.homedir(), '.claude', 'projects');

/** ~/.claude/projects/<项目slug>/<uuid>.jsonl —— 递归找一层即可 */
function allLogs(root) {
  const out = [];
  let subs = [];
  try {
    subs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (_) {
    return out;
  }
  for (const d of subs) {
    const p = path.join(root, d.name);
    for (const f of fs.readdirSync(p)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(p, f);
      out.push({ full, mtime: fs.statSync(full).mtimeMs });
    }
  }
  return out;
}

function pickTarget() {
  const arg = process.argv[2];
  if (arg && fs.existsSync(arg)) return arg;
  const files = allLogs(dir).sort((a, b) => b.mtime - a.mtime);
  if (!files.length) {
    console.error('在 ' + dir + ' 下没找到 .jsonl 日志');
    process.exit(1);
  }
  return files[0].full;
}

const file = pickTarget();
const { rounds } = parseTranscript(fs.readFileSync(file, 'utf8'));

const noise = rounds.filter((r) =>
  /^(Another Claude session|## Context Usage|<)/.test(r.raw.trimStart())
);

console.log('日志:', path.basename(file));
console.log('轮次数:', rounds.length);
console.log('带选项的轮次:', rounds.filter((r) => r.choices.length).length);
console.log('工具动作总数:', rounds.reduce((s, r) => s + r.actions.length, 0));
console.log('系统噪音残留（应为 0）:', noise.length);
for (const n of noise.slice(0, 3)) console.log('  !', JSON.stringify(n.raw.slice(0, 90)));

console.log('\n各轮提示词：');
for (const r of rounds) {
  console.log(`  ${r.index}. [${r.raw.length}字] ${JSON.stringify(r.raw.slice(0, 60))}`);
}
