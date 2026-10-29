'use strict';
/**
 * 假提炼引擎：给自检用，不联网、不调真模型。
 * 约定：从 stdin 读提示词，向 stdout 输出要点。
 */
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  input += d;
});
process.stdin.on('end', () => {
  const lines = input.split(/\r?\n/);
  // 从提示词里认出这一轮的第一条工具动作，好让断言能对上
  const idx = lines.findIndex((l) => l.includes('agent 这一轮执行的动作序列'));
  let first = '';
  for (let i = idx + 1; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s || s.startsWith('===')) continue;
    if (s.startsWith('- ')) { first = s.slice(2); break; }
  }

  process.stdout.write('- 假引擎产出：读了提示词并总结\n');
  process.stdout.write('- 假引擎产出：首个动作是「' + (first || '空') + '」\n');
});
