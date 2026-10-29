'use strict';
/**
 * 一次性验收：用真实 opencode 引擎（免费模型）跑通「导入对话 → 提炼 → recap 落盘」整条链路。
 * 用的是合成日志，不涉及任何真实会话内容。
 * 运行： npx electron test/real-engine-check.js
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeFixture } = require('./fixture-log');
require('../src/main.js'); // 启动真实主进程（会开窗口）

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'realengine-'));
const errors = [];

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  →  ' + detail : ''}`);
  if (!ok) errors.push(name);
}

app.whenReady().then(async () => {
  try {
    await delay(2500);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('窗口未创建');

    const cfg = await win.webContents.executeJavaScript('window.api.getEngineSettings()');
    console.log('当前引擎设置:', JSON.stringify(cfg));

    const logPath = path.join(TMP, 'demo-session.jsonl');
    writeFixture(logPath);

    await win.webContents.executeJavaScript(
      `window.__app.conversations.openLogByPath(${JSON.stringify(logPath)}).then(() => true)`
    );

    // 等真实引擎把两轮都提炼完（每轮约 5~15 秒）
    let recaps = [];
    for (let i = 0; i < 40; i++) {
      await delay(2000);
      recaps = await win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.conv-card')).map(c => Array.from(c.querySelectorAll('.conv-recap li')).map(li => li.textContent))`
      );
      if (recaps.length === 2 && recaps.every((r) => r.length > 0)) break;
    }

    console.log('\n提炼结果:');
    recaps.forEach((r, i) => console.log(' 第' + (i + 1) + '轮:', JSON.stringify(r)));

    check('真实引擎把两轮都提炼出了要点',
      recaps.length === 2 && recaps.every((r) => r.length >= 1), JSON.stringify(recaps));
    check('提炼结果写的是具体动作，不是复述提示词',
      recaps.every((r) => r.some((b) => /list\.tsx|npm run build|layout/.test(b))) &&
      recaps.every((r) => r.every((b) => b.trim() !== '用 CSS Grid' &&
        b.trim() !== '把这个页面改成双栏布局，左边列表右边详情')),
      JSON.stringify(recaps));

    const recapPath = logPath.replace(/\.jsonl$/, '.recap.md');
    check('recap 文件写到日志旁边', fs.existsSync(recapPath), recapPath);
    if (fs.existsSync(recapPath)) {
      const t = fs.readFileSync(recapPath, 'utf8');
      console.log('\n--- recap 文件 ---\n' + t);
      check('recap 文件含两轮', t.includes('recap:1') && t.includes('recap:2'), '');
    }
  } catch (err) {
    console.log('EXCEPTION  ' + ((err && err.stack) || err));
    errors.push('exception');
  } finally {
    console.log('\n' + (errors.length ? `FAILED (${errors.length})` : 'ALL PASS'));
    app.exit(errors.length ? 1 : 0);
  }
});

app.on('window-all-closed', () => {});
