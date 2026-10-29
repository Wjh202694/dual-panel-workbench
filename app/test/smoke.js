'use strict';
/**
 * 端到端自检：导入 → md 规则渲染 → 替换 → 编辑写回原文件 → 外部（agent）改动自动重载 → GBK 往返
 * 运行： npx electron test/smoke.js
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const iconv = require('iconv-lite');

const main = require('../src/main.js');
const { writeFixture } = require('./fixture-log');

const OUT = path.join(__dirname, 'out');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'docsmoke-'));

const MD = `# 项目共识文档

这是**加粗**与*斜体*，还有 \`行内代码\`。

## 二级标题

- 列表项一
- 列表项二

> 引用块

| 字段 | 说明 |
| --- | --- |
| 名称 | 共识工作台 |
`;

const errors = [];

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function check(name, ok, detail) {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  →  ' + detail : ''}`;
  console.log(line);
  if (!ok) errors.push(name + (detail ? ': ' + detail : ''));
}

function openMeta(p, name, ext, kind, content, encoding = 'utf8') {
  return `window.__app.workspace.openDoc({
    path: ${JSON.stringify(p)},
    name: ${JSON.stringify(name)},
    ext: ${JSON.stringify(ext)},
    kind: ${JSON.stringify(kind)},
    content: ${JSON.stringify(content)},
    encoding: ${JSON.stringify(encoding)},
    bom: false
  }).then(() => true)`;
}

async function run(win) {
  /* ---- 1. 界面与 Demo 一致：顶栏两个按钮、上方 8 张空白卡片、下方无任何 chrome ---- */
  const shell_ = await win.webContents.executeJavaScript(`(() => ({
    topbarButtons: document.querySelectorAll('.topbar__btn').length,
    modelButtons: document.querySelectorAll('.topbar__model').length,
    cards: document.querySelectorAll('#ct-top .card').length,
    tabStrip: document.querySelectorAll('.ws__tabs, .tab').length,
    toolbar: document.querySelectorAll('.ws__toolbar, #ws-toolbar').length,
    footBar: document.querySelectorAll('.ws__foot, #ws-foot').length,
    savePill: document.querySelectorAll('.savestate, #savestate').length,
    railThumbs: document.querySelectorAll('.thumb').length,
    splitLabel: document.getElementById('splitRatio').textContent.trim(),
    editorHidden: document.getElementById('editor').hidden,
    bottomText: document.getElementById('ct-bottom').innerText.trim(),
  }))()`);
  check('顶栏两个导入按钮 + 右上角一个模型切换按键',
    shell_.topbarButtons === 2 && shell_.modelButtons === 1, JSON.stringify(shell_));
  check('上方是 Demo 的 8 张空白卡片', shell_.cards === 8, JSON.stringify(shell_));
  check('无标签栏 / 工具栏 / 状态栏 / 保存胶囊',
    shell_.tabStrip === 0 && shell_.toolbar === 0 && shell_.footBar === 0 && shell_.savePill === 0,
    JSON.stringify(shell_));
  check('右侧两条独立滚动条就位', shell_.railThumbs === 2, JSON.stringify(shell_));
  check('未导入文档时下方完全空白', shell_.editorHidden && shell_.bottomText === '', JSON.stringify(shell_));

  /* ---- 2. 导入 md：md 规则生效，且下方不出现任何文档信息 ---- */
  const mdPath = path.join(TMP, '共识.md');
  fs.writeFileSync(mdPath, MD, 'utf8');
  await win.webContents.executeJavaScript(openMeta(mdPath, '共识.md', '.md', 'markdown', MD));
  await delay(1200);

  const md = await win.webContents.executeJavaScript(`(() => ({
    h1: document.querySelectorAll('.ProseMirror h1').length,
    h2: document.querySelectorAll('.ProseMirror h2').length,
    strong: document.querySelectorAll('.ProseMirror strong').length,
    em: document.querySelectorAll('.ProseMirror em').length,
    li: document.querySelectorAll('.ProseMirror li').length,
    quote: document.querySelectorAll('.ProseMirror blockquote').length,
    table: document.querySelectorAll('.ProseMirror table').length,
    code: document.querySelectorAll('.ProseMirror code').length,
    visible: (document.querySelector('.docview--md') || {}).offsetHeight > 0,
    bottomText: document.getElementById('ct-bottom').innerText,
  }))()`);
  check('md 标题规则生效 (h1/h2)', md.h1 === 1 && md.h2 === 1, JSON.stringify(md));
  check('md 强调/列表/引用/表格/行内代码均已渲染',
    md.strong >= 1 && md.em >= 1 && md.li === 2 && md.quote === 1 && md.table === 1 && md.code >= 1,
    JSON.stringify(md));
  check('文档视图确实可见', md.visible === true, JSON.stringify(md));
  check('下方不出现文件名 / 路径',
    !md.bottomText.includes('共识.md') && !md.bottomText.includes(TMP), JSON.stringify({ bottomText: md.bottomText.slice(0, 120) }));

  {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, 'md.png'), img.toPNG());
  }

  /* ---- 3. 导入 txt：替换当前文档 ---- */
  const txtPath = path.join(TMP, '需求.txt');
  fs.writeFileSync(txtPath, '原始内容\n', 'utf8');
  await win.webContents.executeJavaScript(openMeta(txtPath, '需求.txt', '.txt', 'text', '原始内容\n'));
  await delay(700);

  const swapped = await win.webContents.executeJavaScript(`(() => ({
    mdEditors: document.querySelectorAll('.ProseMirror').length,
    txtViews: document.querySelectorAll('.docview--txt').length,
    taVisible: (document.querySelector('.docview--txt textarea') || {}).offsetHeight > 0,
    bottomText: document.getElementById('ct-bottom').innerText,
  }))()`);
  check('导入新文档替换掉旧文档（只留一个编辑器）',
    swapped.mdEditors === 0 && swapped.txtViews === 1, JSON.stringify(swapped));
  check('txt 内容可见', swapped.taVisible === true, JSON.stringify(swapped));
  check('下方仍不出现文件名 / 路径',
    !swapped.bottomText.includes('需求.txt') && !swapped.bottomText.includes(TMP),
    JSON.stringify({ bottomText: swapped.bottomText.slice(0, 120) }));

  /* ---- 4. 编辑后自动写回原文件 ---- */
  await win.webContents.executeJavaScript(`(() => {
    const ta = document.querySelector('.docview--txt textarea');
    ta.value = '原始内容\\n新增一行（模拟人在应用内编辑）\\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await delay(2200); // 等自动保存（防抖 900ms）

  const saved = fs.readFileSync(txtPath, 'utf8');
  check('编辑后自动写回原文件', saved.includes('新增一行'), JSON.stringify(saved));

  const afterSave = await win.webContents.executeJavaScript(`(() => ({
    bannerVisible: document.getElementById('banner').offsetHeight > 0,
  }))()`);
  check('保存后未误报"外部改动"横幅', afterSave.bannerVisible === false, JSON.stringify(afterSave));

  /* ---- 5. 外部（agent）改动：应自动重载 ---- */
  fs.writeFileSync(txtPath, '这是 agent 写入的新内容\n', 'utf8');
  await delay(1600);

  const reloaded = await win.webContents.executeJavaScript(`(() => {
    const ta = document.querySelector('.docview--txt textarea');
    return { value: ta ? ta.value : null };
  })()`);
  check('外部改动被自动重载', !!reloaded.value && reloaded.value.includes('agent 写入'), JSON.stringify(reloaded));

  /* ---- 6. 导入筛选逻辑 + GBK 编码往返 ---- */
  const gbkPath = path.join(TMP, '中文需求.txt');
  const badPath = path.join(TMP, '图片.png');
  fs.writeFileSync(gbkPath, iconv.encode('中文内容：需求说明\n第二行\n', 'gbk'));
  fs.writeFileSync(badPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const picked = await main.loadDocsFromPaths([gbkPath, badPath]);
  check('导入只接受 txt / md，其余跳过',
    picked.docs.length === 1 && picked.skipped.length === 1 && picked.docs[0].path === gbkPath,
    JSON.stringify({ docs: picked.docs.map((d) => d.path), skipped: picked.skipped }));
  check('GBK 文件正确识别并解码',
    picked.docs[0].encoding === 'gbk' && picked.docs[0].content === '中文内容：需求说明\n第二行\n',
    JSON.stringify({ enc: picked.docs[0].encoding, content: picked.docs[0].content }));

  await win.webContents.executeJavaScript(openMeta(gbkPath, '中文需求.txt', '.txt', 'text', picked.docs[0].content, 'gbk'));
  await delay(600);
  await win.webContents.executeJavaScript(`(() => {
    const ta = document.querySelector('.docview--txt textarea');
    ta.value = '中文内容：需求说明（已改）\\n第二行\\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await delay(2200);
  const gbkBytes = fs.readFileSync(gbkPath);
  check('GBK 写回仍是 GBK 字节（非 UTF-8）',
    gbkBytes[0] !== 0xef && iconv.decode(gbkBytes, 'gbk') === '中文内容：需求说明（已改）\n第二行\n',
    JSON.stringify(iconv.decode(gbkBytes, 'gbk')));

  /* ---- 7. 关闭文档后下方恢复空白 ---- */
  await win.webContents.executeJavaScript(`window.__app.workspace.closeDoc()`);
  await delay(400);
  const closed = await win.webContents.executeJavaScript(`(() => ({
    editorHidden: document.getElementById('editor').hidden,
    bottomText: document.getElementById('ct-bottom').innerText.trim(),
  }))()`);
  check('关闭后下方恢复为空白', closed.editorHidden && closed.bottomText === '', JSON.stringify(closed));

  {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, 'empty.png'), img.toPNG());
  }

  /* ---- 8. 导入对话：卡片 / 轮次 / 决策 / recap / 缓存 ---- */
  // 用假引擎（不联网、不调真模型），并把假引擎放到纯 ASCII 临时目录，避免中文路径
  // 用 .cjs：临时目录下面可能有 "type":"module" 的 package.json，
  // 那样 .js 会被 Node 当成 ESM，require 就用不了了
  const fakeEngine = path.join(TMP, 'fake-engine.cjs');
  fs.copyFileSync(path.join(__dirname, 'fake-engine.js'), fakeEngine);

  const origSettings = await win.webContents.executeJavaScript('window.api.getEngineSettings()');
  await win.webContents.executeJavaScript(
    `window.api.setEngineSettings({ engine: 'custom', customCommand: ${JSON.stringify('node "' + fakeEngine + '"')} }).then(() => true)`
  );

  const logPath = path.join(TMP, 'demo-session.jsonl');
  writeFixture(logPath);
  await win.webContents.executeJavaScript(
    `window.__app.conversations.openLogByPath(${JSON.stringify(logPath)}).then(() => true)`
  );
  await delay(5000); // 等假引擎把两轮都提炼完

  const conv = await win.webContents.executeJavaScript(`(() => ({
    blankCards: document.querySelectorAll('#ct-top > .card').length,
    convCards: document.querySelectorAll('.conv-card').length,
    rounds: Array.from(document.querySelectorAll('.conv-card__round')).map(e => e.textContent),
    titles: Array.from(document.querySelectorAll('.conv-sec__title')).map(e => e.textContent),
    prompts: Array.from(document.querySelectorAll('.conv-prompt')).map(e => e.textContent),
    choices: Array.from(document.querySelectorAll('.conv-choice__label')).map(e => e.textContent),
    recaps: Array.from(document.querySelectorAll('.conv-card')).map(c =>
      Array.from(c.querySelectorAll('.conv-recap li')).map(li => li.textContent)),
    pending: document.querySelectorAll('.conv-recap__state--pending').length,
    groupLabelHidden: Array.from(document.querySelectorAll('.conv-group__label')).map(e => e.hidden),
  }))()`);

  check('导入对话后空白占位卡被替换成对话卡片',
    conv.blankCards === 0 && conv.convCards === 3, JSON.stringify(conv));
  check('卡片左上角显示轮次', JSON.stringify(conv.rounds) === '["1","2","3"]', JSON.stringify(conv.rounds));
  check('每张卡片有「决策」「recap」两个小标题',
    JSON.stringify(conv.titles) === '["决策","recap","决策","recap","决策","recap"]', JSON.stringify(conv.titles));
  check('决策里的提示词原样保留（一字不动）',
    conv.prompts[0] === '把这个页面改成双栏布局，左边列表右边详情' &&
    conv.prompts[1] === '用 CSS Grid' &&
    conv.prompts[2] === '然后右上角的图标删去',
    JSON.stringify(conv.prompts));
  check('中途插话也算我的一轮（不能漏）', conv.prompts.length === 3, JSON.stringify(conv.prompts));
  check('系统噪音没混进决策（摘要 / 跨会话转发 / 系统通知）',
    !conv.prompts.some((p) => /Another Claude session|Context Usage|continued from a previous/.test(p)),
    JSON.stringify(conv.prompts));
  check('决策里带出 agent 给我的选项',
    conv.choices.includes('CSS Grid') && conv.choices.includes('Flex 布局'),
    JSON.stringify(conv.choices));
  check('recap 由引擎提炼出要点', conv.recaps.length === 3 && conv.recaps.every((r) => r.length >= 1),
    JSON.stringify(conv.recaps));
  check('只有一个日志时不显示分组标题', conv.groupLabelHidden.length === 1 && conv.groupLabelHidden[0] === true,
    JSON.stringify(conv.groupLabelHidden));

  const recapPath = logPath.replace(/\.jsonl$/, '.recap.md');
  const recapExists = fs.existsSync(recapPath);
  const recapText = recapExists ? fs.readFileSync(recapPath, 'utf8') : '';
  check('recap 产物写到日志旁边', recapExists, recapPath);
  check('recap 文件里三轮都有内容',
    recapText.includes('recap:1') && recapText.includes('recap:2') && recapText.includes('recap:3'),
    recapText.slice(0, 200));

  /* 假引擎每次被调用都会在自己目录留一行 —— 这是"有没有二次提炼"的硬证据 */
  const callLog = path.join(TMP, 'engine-calls.log');
  const engineCalls = () => {
    try {
      return fs.readFileSync(callLog, 'utf8').split('\n').filter(Boolean).length;
    } catch (_) {
      return 0;
    }
  };
  const callsAfterFirst = engineCalls();
  check('提炼 3 轮就调了 3 次引擎（不多不少）',
    callsAfterFirst === 3, `calls=${callsAfterFirst}`);

  {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, 'conv.png'), img.toPNG());
  }

  /* ---- 9. 再导入同一个日志：直接用缓存，不再调引擎 ---- */
  await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.conv-group').forEach(g => g.remove());
    return true;
  })()`);
  await win.webContents.executeJavaScript(
    `window.__app.conversations.openLogByPath(${JSON.stringify(logPath)}).then(() => true)`
  );
  const cached = await win.webContents.executeJavaScript(`(() => ({
    cards: document.querySelectorAll('.conv-card').length,
    bullets: Array.from(document.querySelectorAll('.conv-card')).map(c => c.querySelectorAll('.conv-recap li').length),
    pending: document.querySelectorAll('.conv-recap__state--pending').length,
  }))()`);
  check('重新导入直接用缓存（不再调引擎）',
    cached.cards === 3 && cached.bullets.every((n) => n >= 1) && cached.pending === 0,
    JSON.stringify(cached));
  check('重新导入时引擎一次都没被再叫（真的没有二次提炼）',
    engineCalls() === callsAfterFirst,
    `before=${callsAfterFirst} after=${engineCalls()}`);

  /* ---- 9b. 同一份日志同时导入两次：两组卡片都要拿到结果，不能卡在"提炼中" ---- */
  await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.conv-group').forEach(g => g.remove());
    return true;
  })()`);
  // 把缓存删掉，逼它重新提炼 —— 这样才会撞上"两次导入同时排队"
  try { fs.unlinkSync(path.join(TMP, 'demo-session.recap.md')); } catch (_) {}
  const callsBeforeDup = engineCalls();
  await win.webContents.executeJavaScript(
    `Promise.all([
       window.__app.conversations.openLogByPath(${JSON.stringify(logPath)}),
       window.__app.conversations.openLogByPath(${JSON.stringify(logPath)}),
     ]).then(() => true)`
  );
  await delay(7000);
  const dup = await win.webContents.executeJavaScript(`(() => ({
    groups: document.querySelectorAll('.conv-group').length,
    cards: document.querySelectorAll('.conv-card').length,
    withBullets: Array.from(document.querySelectorAll('.conv-card'))
      .filter(c => c.querySelectorAll('.conv-recap li').length).length,
    pending: document.querySelectorAll('.conv-recap__state--pending').length,
  }))()`);
  check('同一份日志导入两次，两组卡片都拿到 recap（不会卡在"提炼中…"）',
    dup.groups === 2 && dup.cards === 6 && dup.withBullets === 6 && dup.pending === 0,
    JSON.stringify(dup));
  check('同时导入两次也只提炼一轮一次（引擎没被重复调）',
    engineCalls() - callsBeforeDup === 3,
    `多调了 ${engineCalls() - callsBeforeDup} 次`);

  /* ---- 9c. 「重新提炼」：已保存的轮次也能重跑（换模型后有用），并覆盖旧的 ---- */
  const callsBeforeAgain = engineCalls();
  const again = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const btn = document.querySelector('.conv-recap__again');
    if (!btn) return { hasBtn: false };
    btn.click();
    await sleep(5000);
    return {
      hasBtn: true,
      pending: document.querySelectorAll('.conv-recap__state--pending').length,
      bullets: document.querySelectorAll('.conv-card')[0].querySelectorAll('.conv-recap li').length,
    };
  })()`);
  check('已保存的轮次有「重新提炼」按钮', again.hasBtn === true, JSON.stringify(again));
  check('点「重新提炼」会再调一次引擎并覆盖已存的那轮',
    engineCalls() - callsBeforeAgain === 1 && again.bullets >= 1,
    `多调了 ${engineCalls() - callsBeforeAgain} 次 · ${JSON.stringify(again)}`);

  // 还原提炼引擎设置与「最近导入」清单（别把临时文件留在用户真实设置里）
  await win.webContents.executeJavaScript(
    `window.api.setEngineSettings(${JSON.stringify({
      engine: origSettings.engine,
      model: origSettings.model,
      customCommand: origSettings.customCommand,
      recentDocs: origSettings.recentDocs || [],
    })}).then(() => true)`
  );

  /* ---- 10. 提炼引擎设置窗口 ---- */
  main.openEngineDialog();
  await delay(1200);
  const dlg = BrowserWindow.getAllWindows().find((w) => w !== win);
  let dlgInfo = null;
  if (dlg) {
    dlgInfo = await dlg.webContents.executeJavaScript(`(() => ({
      title: document.title,
      options: document.querySelectorAll('#engine option').length,
      model: document.getElementById('model').value,
      cmd: document.getElementById('cmd').value,
    }))()`);
    dlg.close();
  }
  check('提炼引擎设置窗口能打开、列出 3 个引擎',
    !!dlgInfo && dlgInfo.options === 3 && dlgInfo.title === '提炼引擎',
    JSON.stringify(dlgInfo));
  check('设置窗口带回当前模型', !!dlgInfo && !!dlgInfo.model, JSON.stringify(dlgInfo));

  /* ---- 11. 列表选择器：导入对话 / 导入文档都先给一份有名字的清单 ---- */
  main.openPicker('conv');
  await delay(1500);
  const pk = BrowserWindow.getAllWindows().find((w) => w !== win && w !== dlg);
  let pkInfo = null;
  if (pk) {
    pkInfo = await pk.webContents.executeJavaScript(`(() => ({
      title: document.getElementById('title').textContent,
      subtitle: document.getElementById('subtitle').textContent,
      groups: document.querySelectorAll('.group__label').length,
      items: document.querySelectorAll('.item').length,
      firstTitle: (document.querySelector('.item__title') || {}).textContent || '',
      firstSub: (document.querySelector('.item__sub') || {}).textContent || '',
      browse: document.getElementById('browse').textContent,
    }))()`);
    check('选择器窗口自己不会莫名其妙关掉', !pk.isDestroyed(), `alive=${!pk.isDestroyed()}`);
    try {
      await pk.capturePage().then((shot) => {
        fs.writeFileSync(path.join(OUT, 'picker.png'), shot.toPNG());
      }).catch(() => {});
    } catch (_) {}
    pk.close();
  }
  check('导入对话的选择器能打开、列出最近对话',
    !!pkInfo && pkInfo.title === '导入对话' && pkInfo.items > 0, JSON.stringify(pkInfo));
  check('选择器里给的是标题而不是 UUID 文件名',
    !!pkInfo && pkInfo.firstTitle && !/^[0-9a-f-]{36}$/.test(pkInfo.firstTitle),
    JSON.stringify(pkInfo && { firstTitle: pkInfo.firstTitle, firstSub: pkInfo.firstSub }));
  check('选择器里带出项目路径（认得出是哪个项目）',
    !!pkInfo && !!pkInfo.firstSub, JSON.stringify(pkInfo && { firstSub: pkInfo.firstSub }));

  if (pk) {
    try {
      if (!pk.isDestroyed()) pk.close();
    } catch (_) {}
  }

  /* ---- 12. 导入文档的选择器：最近导入 + 项目文件夹 ---- */
  await delay(400);
  main.openPicker('doc');
  await delay(1500);
  const pk2 = BrowserWindow.getAllWindows().find((w) => w !== win && w !== dlg && w !== pk);
  let docInfo = null;
  if (pk2) {
    docInfo = await pk2.webContents.executeJavaScript(`(() => ({
      title: document.getElementById('title').textContent,
      groups: Array.from(document.querySelectorAll('.group__label')).map(e => e.textContent),
      items: document.querySelectorAll('.item').length,
      browse: document.getElementById('browse').textContent,
    }))()`);
    pk2.close();
  }
  check('导入文档的选择器能打开',
    !!docInfo && docInfo.title === '导入文档', JSON.stringify(docInfo));
  check('文档清单按组列出（最近导入 / 项目文件夹）',
    !!docInfo && docInfo.groups.length >= 1, JSON.stringify(docInfo));

  /* ---- 13. 中文 txt 显示诊断（只用合成文件，绝不碰用户私人文件） ---- */
  const settingsBefore = await win.webContents.executeJavaScript('window.api.getEngineSettings()');
  // 把自检窗口提到最前：窗口被完全遮挡时 Chromium 会停掉 rAF，会干扰测量
  try { win.show(); win.focus(); win.moveTop(); } catch (_) {}
  await delay(400);

  const ZH = [
    '中文纯文本显示测试（合成样本 · 非用户文件）',
    '',
    '第一段：这是一段用来检查行距、基线与换行的中文文字。',
    '混排 ASCII：UTF-8 / GBK / textarea / 13.5px / scrollHeight。',
    '',
    '第二段：标点符号，。；：？！（）「」【】——',
    '',
    '第三段：数字 0123456789 与全角 ０１２３４５６７８９',
    'English line: The quick brown fox jumps over the lazy dog.',
    '',
    '最后一行：结束标记 END-OF-SYNTHETIC-FILE',
  ].join('\n');
  const LONG = Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 行：中文内容与 English mixed ${i}`).join('\n');

  const zhPath = path.join(TMP, '合成中文样本.txt');
  const longPath = path.join(TMP, '合成长文档.txt');
  const gbkZhPath = path.join(TMP, '合成GBK样本.txt');
  fs.writeFileSync(zhPath, Buffer.from(ZH, 'utf8'));
  fs.writeFileSync(longPath, Buffer.from(LONG, 'utf8'));
  fs.writeFileSync(gbkZhPath, iconv.encode(ZH, 'gbk'));

  // 解码是否正确（乱码？）
  const zhMeta = await main.readDoc(zhPath);
  check('UTF-8 中文 txt 解码无乱码', zhMeta.content === ZH && zhMeta.encoding === 'utf8',
    JSON.stringify({ enc: zhMeta.encoding, head: zhMeta.content.slice(0, 40) }));
  const gbkZhMeta = await main.readDoc(gbkZhPath);
  check('GBK 中文 txt 解码无乱码', gbkZhMeta.content === ZH && gbkZhMeta.encoding === 'gbk',
    JSON.stringify({ enc: gbkZhMeta.encoding, head: gbkZhMeta.content.slice(0, 40) }));

  const measure = `(() => {
    const ta = document.querySelector('.docview--txt textarea');
    if (!ta) return null;
    const cs = getComputedStyle(ta);
    const r = ta.getBoundingClientRect();
    return {
      valueLen: ta.value.length,
      lineCount: ta.value.split('\\n').length,
      styleHeight: ta.style.height,
      offsetHeight: ta.offsetHeight,
      clientHeight: ta.clientHeight,
      scrollHeight: ta.scrollHeight,
      clientWidth: ta.clientWidth,
      overflowY: cs.overflowY,
      overflowX: cs.overflowX,
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      lineHeight: cs.lineHeight,
      whiteSpace: cs.whiteSpace,
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    };
  })()`;

  // --- 13a. 中文 txt 打开后的实际排版度量 ---
  await win.webContents.executeJavaScript(
    openMeta(zhPath, '合成中文样本.txt', '.txt', 'text', zhMeta.content, zhMeta.encoding)
  );
  await delay(900);
  const zhM = await win.webContents.executeJavaScript(measure);
  check('中文 txt：textarea 已渲染', !!zhM, JSON.stringify(zhM));
  if (zhM) {
    console.log('   [13a] 中文 txt 度量 = ' + JSON.stringify(zhM));
    const visibleLines = zhM.lineHeight !== 'normal'
      ? zhM.clientHeight / parseFloat(zhM.lineHeight)
      : NaN;
    console.log('   [13a] 可见行数约 = ' + visibleLines.toFixed(2) + ' / 实际行数 ' + zhM.lineCount);
    check('中文 txt：文字没有被截断（scrollHeight <= clientHeight）',
      zhM.scrollHeight <= zhM.clientHeight + 1,
      JSON.stringify({ scrollHeight: zhM.scrollHeight, clientHeight: zhM.clientHeight, styleHeight: zhM.styleHeight }));
    check('中文 txt：行高是 1.85 倍（未被其它字体改变）',
      Math.abs(parseFloat(zhM.lineHeight) - 13.5 * 1.85) < 0.6,
      JSON.stringify({ lineHeight: zhM.lineHeight, fontSize: zhM.fontSize, fontFamily: zhM.fontFamily }));
  }
  {
    const shot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, 'txt-cn-utf8.png'), shot.toPNG());
  }
  if (zhM) {
    const shot = await win.webContents.capturePage(zhM.rect);
    fs.writeFileSync(path.join(OUT, 'txt-cn-utf8-crop.png'), shot.toPNG());
  }

  // --- 13b. GBK 中文 txt 打开后是否正常 ---
  await win.webContents.executeJavaScript(
    openMeta(gbkZhPath, '合成GBK样本.txt', '.txt', 'text', gbkZhMeta.content, gbkZhMeta.encoding)
  );
  await delay(900);
  const gbkM = await win.webContents.executeJavaScript(measure);
  console.log('   [13b] GBK 中文 txt 度量 = ' + JSON.stringify(gbkM));
  {
    const shot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, 'txt-cn-gbk.png'), shot.toPNG());
  }

  // --- 13c. 长文档：高度是否够放全部内容 ---
  const longMeta = await main.readDoc(longPath);
  await win.webContents.executeJavaScript(
    openMeta(longPath, '合成长文档.txt', '.txt', 'text', longMeta.content, longMeta.encoding)
  );
  await delay(900);
  const longM = await win.webContents.executeJavaScript(measure);
  console.log('   [13c] 长文档度量 = ' + JSON.stringify(longM));
  if (longM) {
    const need = longM.lineCount * parseFloat(longM.lineHeight);
    console.log('   [13c] 内容所需高度约 ' + need.toFixed(1) + 'px，实测 clientHeight=' + longM.clientHeight);
    check('长文档：内容高度没有被压缩',
      longM.scrollHeight <= longM.clientHeight + 1,
      JSON.stringify({ scrollHeight: longM.scrollHeight, clientHeight: longM.clientHeight, styleHeight: longM.styleHeight }));
  }
  {
    const shot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, 'txt-cn-long.png'), shot.toPNG());
  }

  // --- 13d. 改窗口宽度后，高度是否重新计算（autoGrow 是否失效） ---
  const beforeResize = await win.webContents.executeJavaScript(measure);
  const oldSize = win.getSize();
  win.setSize(Math.max(900, oldSize[0] - 420), oldSize[1]);
  await delay(900);
  const afterResize = await win.webContents.executeJavaScript(measure);
  console.log('   [13d] 改宽度前 = ' + JSON.stringify(beforeResize));
  console.log('   [13d] 改宽度后 = ' + JSON.stringify(afterResize));
  check('改变窗口宽度后文字高度会重算（autoGrow 未失效）',
    !!afterResize && afterResize.scrollHeight <= afterResize.clientHeight + 1,
    JSON.stringify(afterResize && {
      scrollHeight: afterResize.scrollHeight,
      clientHeight: afterResize.clientHeight,
      styleHeight: afterResize.styleHeight,
    }));
  {
    const shot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, 'txt-cn-resized.png'), shot.toPNG());
  }
  win.setSize(oldSize[0], oldSize[1]);
  await delay(600);

  /* ---- 13e. 行盒度量 + 实际回退字体（为什么中文看起来不对） ---- */
  const probe = await win.webContents.executeJavaScript(`(() => {
    const ta = document.querySelector('.docview--txt textarea');
    const cs = getComputedStyle(ta);
    const TEXT = ${JSON.stringify(ZH)};

    // (1) 用同款字体造一个探针 div，量每一行实际占多高
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;left:-99999px;top:0;white-space:pre-wrap;padding:0;border:0;width:' + ta.clientWidth + 'px';
    d.style.fontFamily = cs.fontFamily;
    d.style.fontSize = cs.fontSize;
    d.style.lineHeight = cs.lineHeight;
    d.textContent = TEXT;
    document.body.appendChild(d);
    const node = d.firstChild;
    const lines = TEXT.split('\\n');
    const lineBoxes = [];
    let pos = 0;
    let prevTop = null;
    for (const L of lines) {
      const r = document.createRange();
      r.setStart(node, pos);
      r.setEnd(node, pos + L.length);
      const rects = Array.from(r.getClientRects());
      const top = rects.length ? rects[0].top : null;
      const h = rects.length ? rects[0].height : null;
      lineBoxes.push({
        t: L.slice(0, 12),
        top: top === null ? null : +top.toFixed(2),
        h: h === null ? null : +h.toFixed(2),
        step: prevTop !== null && top !== null ? +(top - prevTop).toFixed(2) : null,
      });
      if (top !== null) prevTop = top;
      pos += L.length + 1;
    }
    const probeH = d.getBoundingClientRect().height;
    d.remove();

    // (2) canvas 量字符墨迹高度，找出中文实际落到哪个字体、画得多大
    const c = document.createElement('canvas');
    c.width = 80; c.height = 80;
    const g = c.getContext('2d');
    const ink = (family) => {
      g.clearRect(0, 0, 80, 80);
      g.font = cs.fontSize + ' ' + family;
      g.textBaseline = 'alphabetic';
      g.fillStyle = '#000';
      g.fillText('中文', 4, 40);
      const m = g.measureText('中文');
      const px = g.getImageData(0, 0, 80, 80).data;
      let sig = 0;
      for (let i = 3; i < px.length; i += 4) sig = (sig * 31 + px[i]) >>> 0; // 用 alpha 通道做指纹
      return {
        width: +m.width.toFixed(3),
        asc: +m.actualBoundingBoxAscent.toFixed(2),
        desc: +m.actualBoundingBoxDescent.toFixed(2),
        fontAsc: +m.fontBoundingBoxAscent.toFixed(2),
        fontDesc: +m.fontBoundingBoxDescent.toFixed(2),
        sig,
      };
    };
    const base = ink(cs.fontFamily);
    const cands = ['monospace', 'Consolas', 'SimSun', 'NSimSun', 'Microsoft YaHei', 'Microsoft YaHei UI',
      'SimHei', 'KaiTi', 'FangSong', 'DengXian', 'Microsoft JhengHei', 'Noto Sans CJK SC', 'Source Han Sans SC'];
    const byFont = cands.map((f) => ({ f, ...ink('"' + f + '"') }));
    const matches = byFont.filter((x) => x.sig === base.sig).map((x) => x.f);
    const ascii = ink('Consolas');

    return { lineBoxes, probeH, base, ascii, matches, byFont };
  })()`);
  console.log('   [13e] 每行行盒 = ' + JSON.stringify(probe.lineBoxes));
  console.log('   [13e] 探针总高 = ' + probe.probeH);
  console.log('   [13e] 中文墨迹(当前栈) = ' + JSON.stringify(probe.base));
  console.log('   [13e] 拉丁墨迹(Consolas) = ' + JSON.stringify(probe.ascii));
  console.log('   [13e] 与当前栈像素一致的候选字体 = ' + JSON.stringify(probe.matches));
  console.log('   [13e] 各候选字体度量 = ' + JSON.stringify(probe.byFont));

  // (3) 放大截图，肉眼看中文与拉丁的字形/基线
  await win.webContents.executeJavaScript('window.__app.workspace.closeDoc()');
  await delay(300);
  await win.webContents.executeJavaScript(
    openMeta(zhPath, '合成中文样本.txt', '.txt', 'text', zhMeta.content, zhMeta.encoding)
  );
  await delay(900);
  await win.webContents.executeJavaScript('window.__app.workspace.closeDoc()');
  await delay(200);
  await win.webContents.executeJavaScript(
    openMeta(zhPath, '合成中文样本.txt', '.txt', 'text', zhMeta.content, zhMeta.encoding)
  );
  await delay(900);
  {
    const r = await win.webContents.executeJavaScript(`(() => {
      const ta = document.querySelector('.docview--txt textarea');
      const b = ta.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.min(300, Math.round(b.height)) };
    })()`);
    win.webContents.setZoomFactor(2);
    await delay(700);
    const shot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, 'txt-cn-zoom2.png'), shot.toPNG());
    win.webContents.setZoomFactor(1);
    await delay(300);
    void r;
  }

  /* ---- 14. autoGrow / rAF 时序：高度到底算出来了没有 ---- */
  const taState = `(() => {
    const ta = document.querySelector('.docview--txt textarea');
    if (!ta) return null;
    return {
      styleH: ta.style.height,
      clientH: ta.clientHeight,
      scrollH: ta.scrollHeight,
      vis: document.visibilityState,
      hidden: document.hidden,
    };
  })()`;

  // 14a. 正常可见窗口下，打开后按时间点观察 autoGrow 有没有执行
  await win.webContents.executeJavaScript('window.__app.workspace.closeDoc()');
  await delay(400);
  await win.webContents.executeJavaScript(
    'window.__raf = { n: 0 }; (function f(){ if (window.__raf.n++ < 2000) requestAnimationFrame(f); })();'
  );
  await win.webContents.executeJavaScript(
    openMeta(zhPath, '合成中文样本.txt', '.txt', 'text', zhMeta.content, zhMeta.encoding)
  );
  const timeline = [];
  for (const step of [0, 100, 200, 500, 1000]) {
    if (step) await delay(step);
    const s = await win.webContents.executeJavaScript(taState);
    timeline.push({ at: step, ...s });
  }
  const rafN = await win.webContents.executeJavaScript('window.__raf.n');
  console.log('   [14a] 打开后时间线 = ' + JSON.stringify(timeline));
  console.log('   [14a] 期间页面自身 rAF 触发次数 = ' + rafN);

  // 14b. 窗口被隐藏/遮挡时打开文档：rAF 停摆 → autoGrow 不执行
  await win.webContents.executeJavaScript('window.__app.workspace.closeDoc()');
  await delay(300);
  win.hide();
  await delay(600);
  await win.webContents.executeJavaScript(
    openMeta(zhPath, '合成中文样本.txt', '.txt', 'text', zhMeta.content, zhMeta.encoding)
  );
  await delay(1200);
  const hiddenState = await win.webContents.executeJavaScript(taState);
  console.log('   [14b] 窗口隐藏时打开文档 = ' + JSON.stringify(hiddenState));
  win.show();
  await delay(1500);
  const shownState = await win.webContents.executeJavaScript(taState);
  console.log('   [14b] 窗口恢复显示后 = ' + JSON.stringify(shownState));
  {
    const shot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, 'txt-cn-shown-again.png'), shot.toPNG());
  }
  check('窗口恢复显示后高度自动补上（autoGrow 未失效）',
    !!shownState && shownState.scrollH <= shownState.clientH + 1,
    JSON.stringify({ hiddenState, shownState }));

  // 14c. 手动模拟一次 input 事件（用户敲一下键盘）能不能救回来
  await win.webContents.executeJavaScript(`(() => {
    const ta = document.querySelector('.docview--txt textarea');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await delay(400);
  const afterInput = await win.webContents.executeJavaScript(taState);
  console.log('   [14c] 手动触发 input 之后 = ' + JSON.stringify(afterInput));

  /* ---- 15. 右上角「切换模型」按键 ---- */
  const modelBox = await win.webContents.executeJavaScript(`(() => ({
    buttons: document.querySelectorAll('.topbar__model').length,
    label: (document.getElementById('model-name') || {}).textContent || '',
  }))()`);
  check('顶栏右上角有一个模型切换按键',
    modelBox.buttons === 1 && !!modelBox.label && modelBox.label !== '…',
    JSON.stringify(modelBox));

  const switched = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    document.getElementById('btn-model').click();
    await sleep(250);
    const items = Array.from(document.querySelectorAll('.modelmenu__item'));
    const open = !document.getElementById('model-menu').hidden;
    const before = document.getElementById('model-name').textContent;
    const target = items.find(e => e.getAttribute('aria-checked') !== 'true');
    if (target) target.click();
    await sleep(800);
    return {
      open, count: items.length, before,
      after: document.getElementById('model-name').textContent,
      closed: document.getElementById('model-menu').hidden,
      checkedNow: Array.from(document.querySelectorAll('.modelmenu__item'))
        .filter(e => e.getAttribute('aria-checked') === 'true').length,
    };
  })()`);
  check('点模型按键能展开模型清单（不止一个可选项）',
    switched.open && switched.count >= 3, JSON.stringify(switched));
  check('选一个模型后立刻生效（按钮名字变了、菜单收起）',
    !!switched.after && switched.after !== switched.before && switched.closed,
    JSON.stringify(switched));
  check('切换后清单里只有一个是选中态',
    switched.checkedNow === 1, JSON.stringify(switched));

  // 收尾：关掉文档、还原设置
  await win.webContents.executeJavaScript('window.__app.workspace.closeDoc()');
  await delay(300);
  await win.webContents.executeJavaScript(
    `window.api.setEngineSettings(${JSON.stringify({
      engine: settingsBefore.engine,
      model: settingsBefore.model,
      customCommand: settingsBefore.customCommand,
      recentDocs: settingsBefore.recentDocs || [],
    })}).then(() => true)`
  );
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // 看门狗：自检卡死时也要退出，别留下占着窗口的僵尸进程
  setTimeout(() => {
    console.log('WATCHDOG  自检超时，强制退出');
    app.exit(2);
  }, 180000);
  try {
    await delay(2500);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('窗口未创建');
    await run(win);
  } catch (err) {
    console.log('EXCEPTION  ' + ((err && err.stack) || err));
    errors.push('exception: ' + ((err && err.message) || err));
  } finally {
    console.log('\n' + (errors.length ? `FAILED (${errors.length}):\n- ` + errors.join('\n- ') : 'ALL PASS'));
    app.exit(errors.length ? 1 : 0);
  }
});

app.on('window-all-closed', () => {});
