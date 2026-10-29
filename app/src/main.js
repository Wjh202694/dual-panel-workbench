'use strict';
/**
 * 主进程：窗口、文件对话框、读写落盘、外部变更监听、菜单
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const iconv = require('iconv-lite');
const conv = require('./conv/service');
const cache = require('./conv/cache');
const distill = require('./conv/distill');
const recent = require('./conv/recent');
const docRecent = require('./doc/recent');
const { readSettings, writeSettings } = require('./conv/settings');
const { MODEL_PRESETS, shortLabel } = require('./conv/models');

/**
 * 能导入的文件类型：文档 + 5 种主流源代码（Python、JS/TS 家族）。
 * 源代码跟 txt 一样按纯文本编辑，不走 Markdown 排版。
 * （跟 doc/recent.js 用同一个集合，别各写一份。）
 */
const ALLOWED_EXT = docRecent.DOC_EXT;
const CODE_EXT = ['py', 'js', 'ts', 'tsx', 'jsx'];

let win = null;

/* ============================================================
 * 编码处理：中文 txt 常见 GBK，需原样读回、原样写回
 * ============================================================ */
function decodeBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.slice(3).toString('utf8'), encoding: 'utf8', bom: true };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.slice(2).toString('utf16le'), encoding: 'utf16le', bom: true };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.slice(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf16be', bom: true };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf8', bom: false };
  } catch (_) {
    /* 不是合法 UTF-8，继续尝试 GBK */
  }
  try {
    return { text: new TextDecoder('gbk').decode(buf), encoding: 'gbk', bom: false };
  } catch (_) {
    /* 兜底 */
  }
  return { text: buf.toString('utf8'), encoding: 'utf8', bom: false };
}

function encodeText(text, encoding, bom) {
  if (encoding === 'gbk') {
    const body = iconv.encode(text, 'gbk');
    return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
  }
  if (encoding === 'utf16le') {
    const body = Buffer.from(text, 'utf16le');
    return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
  }
  if (encoding === 'utf16be') {
    const body = Buffer.from(text, 'utf16le');
    body.swap16();
    return bom ? Buffer.concat([Buffer.from([0xfe, 0xff]), body]) : body;
  }
  const body = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

async function readDoc(filePath) {
  const buf = await fsp.readFile(filePath);
  const dec = decodeBuffer(buf);
  const ext = path.extname(filePath).toLowerCase();
  return {
    path: filePath,
    name: path.basename(filePath),
    ext,
    kind: ext === '.md' || ext === '.markdown' ? 'markdown' : 'text',
    content: dec.text,
    encoding: dec.encoding,
    bom: dec.bom,
  };
}

/* ============================================================
 * 外部变更监听：watch 目录而非文件，文件被替换（原子保存）也不丢
 * ============================================================ */
const dirWatchers = new Map(); // dir -> { watcher, files:Set<string>, timer:Map }

function watchDoc(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  let entry = dirWatchers.get(dir);
  if (!entry) {
    const files = new Set();
    const timer = new Map();
    const watcher = fs.watch(dir, { persistent: true }, (_evt, filename) => {
      if (!filename) return;
      const name = filename.toString();
      if (!files.has(name)) return;
      // 合并同一文件的连续事件（编辑器保存常触发多次）
      clearTimeout(timer.get(name));
      timer.set(
        name,
        setTimeout(async () => {
          timer.delete(name);
          try {
            const doc = await readDoc(path.join(dir, name));
            if (win && !win.isDestroyed()) {
              win.webContents.send('doc:external-change', {
                path: doc.path,
                content: doc.content,
                encoding: doc.encoding,
                bom: doc.bom,
              });
            }
          } catch (_) {
            if (win && !win.isDestroyed()) {
              win.webContents.send('doc:external-removed', { path: path.join(dir, name) });
            }
          }
        }, 220)
      );
    });
    watcher.on('error', () => {
      try { watcher.close(); } catch (_) {}
      dirWatchers.delete(dir);
    });
    entry = { watcher, files, timer };
    dirWatchers.set(dir, entry);
  }
  entry.files.add(base);
}

function unwatchDoc(filePath) {
  const dir = path.dirname(filePath);
  const entry = dirWatchers.get(dir);
  if (!entry) return;
  entry.files.delete(path.basename(filePath));
  if (entry.files.size === 0) {
    try { entry.watcher.close(); } catch (_) {}
    dirWatchers.delete(dir);
  }
}

/* ============================================================
 * IPC
 * ============================================================ */
ipcMain.handle('doc:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '导入文档',
    buttonLabel: '导入',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '文本文档（.txt / .md）', extensions: ['txt', 'md', 'markdown'] },
      { name: 'Markdown 文档', extensions: ['md', 'markdown'] },
      { name: '源代码（.py / .js / .ts…）', extensions: CODE_EXT },
      { name: '纯文本', extensions: ['txt'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return { docs: [], skipped: [] };
  return loadDocsFromPaths(res.filePaths);
});

/** 从一组路径中挑出受支持的文档并读入；其余返回 skipped */
async function loadDocsFromPaths(paths) {
  const docs = [];
  const skipped = [];
  for (const p of paths || []) {
    const ext = path.extname(p).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      skipped.push(p);
      continue;
    }
    try {
      docs.push(await readDoc(p));
    } catch (_) {
      skipped.push(p);
    }
  }
  return { docs, skipped };
}

ipcMain.handle('doc:save', async (_e, payload) => {
  const { filePath, content, encoding, bom } = payload || {};
  if (!filePath) throw new Error('缺少文件路径');
  const buf = encodeText(String(content ?? ''), encoding || 'utf8', !!bom);
  await fsp.writeFile(filePath, buf);
  return { ok: true, savedAt: Date.now(), bytes: buf.length };
});

ipcMain.handle('doc:watch', async (_e, filePath) => {
  if (filePath) watchDoc(filePath);
  return { ok: true };
});

ipcMain.handle('doc:read', async (_e, filePath) => {
  if (!filePath) throw new Error('缺少文件路径');
  return readDoc(filePath);
});

ipcMain.handle('doc:unwatch', async (_e, filePath) => {
  if (filePath) unwatchDoc(filePath);
  return { ok: true };
});

ipcMain.handle('doc:reveal', async (_e, filePath) => {
  if (!filePath) return { ok: false };
  shell.showItemInFolder(filePath);
  return { ok: true };
});

ipcMain.handle('doc:open-external', async (_e, filePath) => {
  if (!filePath) return { ok: false };
  const err = await shell.openPath(filePath);
  return { ok: !err, error: err };
});

ipcMain.handle('doc:open-path', async (_e, filePath) => {
  if (!filePath) throw new Error('缺少文件路径');
  const doc = await readDoc(filePath);
  docRecent.rememberDoc(doc);
  return doc;
});

ipcMain.handle('doc:remember', async (_e, filePath) => {
  if (!filePath) return { ok: false };
  try {
    await docRecent.rememberDoc({ path: filePath, name: path.basename(filePath) });
  } catch (_) {}
  return { ok: true };
});

ipcMain.handle('app:info', async () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  platform: process.platform,
  sep: path.sep,
}));

/* ============================================================
 * 对话导入：解析日志 → 卡片；调引擎提炼 → recap（并落盘缓存）
 * ============================================================ */

/** 对话日志通常在 ~/.claude/projects 下，文件框默认开到这里，省得翻 */
function convDefaultDir() {
  const home = app.getPath('home');
  const projects = path.join(home, '.claude', 'projects');
  try {
    if (fs.existsSync(projects)) return projects;
  } catch (_) {}
  return undefined;
}

ipcMain.handle('conv:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '导入对话日志',
    buttonLabel: '导入',
    defaultPath: convDefaultDir(),
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '对话日志（.jsonl）', extensions: ['jsonl', 'json', 'log'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return { logs: [], errors: [] };
  const logs = [];
  const errors = [];
  for (const p of res.filePaths) {
    try {
      const c = await conv.loadConversation(p);
      if (!c.rounds.length) {
        errors.push({ path: p, name: path.basename(p), message: '没在这个文件里解析出对话轮次' });
        continue;
      }
      logs.push(c);
    } catch (err) {
      errors.push({ path: p, name: path.basename(p), message: err.message });
    }
  }
  return { logs, errors };
});

/** 不弹框，直接按路径读（供自动化自检用） */
ipcMain.handle('conv:load', async (_e, filePath) => {
  if (!filePath) throw new Error('缺少日志路径');
  return conv.loadConversation(filePath);
});

/** 某一轮改了哪些代码：在哪个文件、哪一行新增了什么、删除了什么 */
ipcMain.handle('conv:code', async (_e, payload) => {
  const { filePath, index } = payload || {};
  if (!filePath) throw new Error('缺少日志路径');
  return conv.loadRoundCode(filePath, Number(index));
});

/**
 * 刷新：日志文件导入之后还在往下写，这里只把「比已显示的更靠后的」轮次带出来。
 * 一次最多带 3 轮（免得一口气把免费模型额度打爆），剩下的下一次刷新再带。
 */
const MAX_NEW_ROUNDS = 3;

ipcMain.handle('conv:reload', async (_e, payload) => {
  const { filePath, afterIndex, limit } = payload || {};
  if (!filePath) throw new Error('缺少日志路径');
  const n = Math.min(Math.max(Number(limit) || MAX_NEW_ROUNDS, 0), MAX_NEW_ROUNDS);
  return conv.loadNewRounds(filePath, Number(afterIndex) || 0, n);
});

ipcMain.handle('conv:distill', async (_e, payload) => {
  const { filePath, index } = payload || {};
  if (!filePath) throw new Error('缺少日志路径');
  return conv.distillRound(filePath, Number(index));
});

ipcMain.handle('conv:recap-file', async (_e, filePath) => {
  if (!filePath) throw new Error('缺少日志路径');
  const p = cache.recapPathFor(filePath);
  return { path: p, exists: fs.existsSync(p) };
});

ipcMain.handle('conv:settings:get', async () => readSettings());

ipcMain.handle('conv:settings:set', async (_e, patch) => {
  const next = writeSettings(patch || {});
  buildMenu();
  broadcastEngine();
  return next;
});

ipcMain.handle('conv:engines', async () => distill.ENGINES);

ipcMain.handle('conv:models', async () => MODEL_PRESETS);

/** 顶栏「切换模型」按键：换模型后把新设置广播回渲染层，刷新按钮上的名字 */
ipcMain.handle('engine:open', async () => {
  openEngineDialog();
  return true;
});

/**
 * 「测试连接」：用当前填的配置真跑一次引擎，把结果或原因给回设置窗口。
 * 不保存任何东西 —— 只测。
 */
ipcMain.handle('engine:test', async (_e, patch) => {
  const base = readSettings();
  const cfg = { ...base, ...(patch || {}) };
  if (!distill.ENGINES.some((e) => e.id === cfg.engine)) {
    throw new Error('引擎不对');
  }
  cfg.model = String(cfg.model || '').trim();
  cfg.customCommand = String(cfg.customCommand || '').trim();
  cfg.apiBaseUrl = String(cfg.apiBaseUrl || '').trim();
  cfg.apiKey = String(cfg.apiKey || '').trim();
  cfg.apiFormat = cfg.apiFormat === 'anthropic' ? 'anthropic' : 'openai';
  // 测试别等太久
  cfg.timeoutMs = Math.min(Number(cfg.timeoutMs) || 60000, 60000);

  const prompt = '这是一次连通性测试。只回复「收到」两个字，不要多说别的。';
  const out = await distill.runEngine(cfg, prompt, { cwd: app.getPath('userData') });
  const text = String(distill.extractText(cfg.engine, out) || '').trim();
  if (!text) throw new Error('引擎跑通了，但没返回任何文本');
  return { ok: true, sample: text.slice(0, 200) };
});

function broadcastEngine() {
  if (win && !win.isDestroyed()) win.webContents.send('engine:changed', readSettings());
}

/* ============================================================
 * 提炼引擎设置窗口（独立小窗，主界面一点不脏）
 * ============================================================ */
let dlgWin = null;

function openEngineDialog() {
  if (dlgWin && !dlgWin.isDestroyed()) {
    dlgWin.focus();
    return;
  }
  dlgWin = new BrowserWindow({
    width: 520,
    // API 引擎那一档有 5 个字段（地址 / Key / 模型 / 接口格式 / 引擎），
    // 全显示、三个字段同时报错、还带一行状态提示时内容约 576px；
    // 窗口给到 640，一行都不用滚（窗口本身也可以拉大拉小）。
    height: 640,
    minWidth: 460,
    minHeight: 360,
    resizable: true,
    minimizable: false,
    maximizable: false,
    show: false,
    title: '提炼引擎',
    backgroundColor: '#f4f6f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  dlgWin.loadFile(path.join(__dirname, 'engine-dialog.html'));
  dlgWin.once('ready-to-show', () => dlgWin.show());
  dlgWin.on('closed', () => {
    dlgWin = null;
  });
}

ipcMain.on('engine:close', () => {
  if (dlgWin && !dlgWin.isDestroyed()) dlgWin.close();
});

/* ============================================================
 * 选择器窗口：导入对话 / 导入文档都先给一份有名字的清单
 * ============================================================ */
let pickerWin = null;
let pickerData = null;

function buildPickerData(kind) {
  if (kind === 'conv') {
    const sessions = recent.listSessions();
    return {
      kind,
      title: '导入对话',
      subtitle: '选一次对话，导入成上方的轮次卡片。清单按最近修改排序，标题是 Claude 给这次对话起的名字。',
      browseLabel: '浏览其他日志…',
      emptyText: '没找到对话日志。',
      groups: sessions.length
        ? [
            {
              label: '最近对话',
              items: sessions.map((s) => ({
                path: s.path,
                title: s.title || (s.firstPrompt ? s.firstPrompt.slice(0, 36) + '…' : s.file),
                subtitle: s.cwd || s.project,
                meta: `${recent.humanTime(s.mtime)} · ${recent.humanSize(s.size)}`,
                action: '导入',
              })),
            },
          ]
        : [],
    };
  }

  // 文档
  const cands = docRecent.listDocCandidates();
  const groups = [];
  if (cands.recent.length) {
    groups.push({
      label: '最近导入',
      items: cands.recent.map((d) => ({
        path: d.path,
        title: d.name,
        subtitle: path.dirname(d.path),
        meta: recent.humanTime(d.at),
        action: '打开',
      })),
    });
  }
  for (const g of cands.projects) {
    groups.push({
      label: g.dir,
      items: g.items.map((i) => ({
        path: i.path,
        title: i.name,
        subtitle: '',
        meta: recent.humanTime(i.mtime),
        action: '打开',
      })),
    });
  }
  return {
    kind: 'doc',
    title: '导入文档',
    subtitle: '选一份共识文档，在下方编辑并写回原文件。清单来自你导入过的对话所在的项目文件夹。',
    browseLabel: '浏览其他文件…',
    emptyText: '还没有文档。可以点「浏览其他文件…」去找。',
    groups,
  };
}

function closePicker() {
  if (pickerWin && !pickerWin.isDestroyed()) pickerWin.close();
  pickerWin = null;
}

function openPicker(kind) {
  if (pickerWin && !pickerWin.isDestroyed()) {
    pickerWin.focus();
    return;
  }
  let data;
  try {
    data = buildPickerData(kind);
  } catch (err) {
    dialog.showErrorBox('打开清单失败', String((err && err.message) || err));
    return;
  }
  pickerData = data;

  pickerWin = new BrowserWindow({
    width: 760,
    height: 640,
    parent: win || undefined,
    show: false,
    title: data.title,
    backgroundColor: '#eef1f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  pickerWin.loadFile(path.join(__dirname, 'picker.html'));
  pickerWin.once('ready-to-show', () => pickerWin.show());
  pickerWin.on('closed', () => {
    pickerWin = null;
    pickerData = null;
  });
}

/** 页面自己来取清单（避免"消息比监听先到"被丢掉） */
ipcMain.handle('picker:get-data', async () => pickerData);

/** 选择器里点了某一项 */
ipcMain.on('picker:choose', (_e, item) => {
  const path_ = item && item.path;
  closePicker();
  if (!path_) return;
  if (win && !win.isDestroyed()) win.webContents.send('picker:result', { kind: item.kind, path: path_ });
});

ipcMain.on('picker:cancel', () => {
  closePicker();
});

/** 渲染层点「导入对话」「导入文档」时开选择器 */
ipcMain.handle('picker:open', async (_e, kind) => {
  openPicker(kind === 'doc' ? 'doc' : 'conv');
  return true;
});

/** 选择器里点了「浏览其他文件…」：回到系统文件框 */
ipcMain.on('picker:browse', async (_e, kind) => {
  if (kind === 'conv') {
    const res = await dialog.showOpenDialog(win || undefined, {
      title: '导入对话日志',
      buttonLabel: '导入',
      defaultPath: convDefaultDir(),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '对话日志（.jsonl）', extensions: ['jsonl', 'json', 'log'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    closePicker();
    if (res.canceled || !res.filePaths.length) return;
    if (win && !win.isDestroyed()) {
      win.webContents.send('picker:result', { kind: 'conv', path: res.filePaths[0] });
    }
    return;
  }

  const res = await dialog.showOpenDialog(win || undefined, {
    title: '导入文档',
    buttonLabel: '导入',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '文本文档（.txt / .md）', extensions: ['txt', 'md', 'markdown'] },
      { name: 'Markdown 文档', extensions: ['md', 'markdown'] },
      { name: '源代码（.py / .js / .ts…）', extensions: CODE_EXT },
      { name: '纯文本', extensions: ['txt'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  closePicker();
  if (res.canceled || !res.filePaths.length) return;
  const loaded = await loadDocsFromPaths(res.filePaths);
  if (win && !win.isDestroyed()) {
    win.webContents.send('picker:result', { kind: 'doc-picked', docs: loaded.docs, skipped: loaded.skipped });
  }
});

/* ============================================================
 * 菜单
 * ============================================================ */
function sendMenu(action) {
  if (win && !win.isDestroyed()) win.webContents.send('menu:action', action);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const cfg = readSettings();
  const engineItems = distill.ENGINES.map((e) => ({
    label: e.label,
    type: 'radio',
    checked: cfg.engine === e.id,
    click: () => {
      writeSettings({ engine: e.id });
      buildMenu();
      broadcastEngine();
    },
  }));

  const modelItems = MODEL_PRESETS.map((m) => ({
    label: m.label,
    type: 'radio',
    checked: cfg.engine === 'opencode' && cfg.model === m.id,
    click: () => {
      writeSettings({ engine: 'opencode', model: m.id });
      buildMenu();
      broadcastEngine();
    },
  }));

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '导入对话…', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendMenu('import-conv') },
        { label: '导入文档…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('import-doc') },
        { type: 'separator' },
        { label: '保存当前文档', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save') },
        { type: 'separator' },
        { label: '在文件夹中显示', accelerator: 'CmdOrCtrl+Shift+R', click: () => sendMenu('reveal') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: '退出' },
      ],
    },
    { role: 'editMenu', label: '编辑' },
    {
      label: '工具',
      submenu: [
        { label: '提炼缺失的 recap', click: () => sendMenu('distill-all') },
        { type: 'separator' },
        { label: '切换提炼模型', submenu: modelItems },
        { label: '提炼引擎', submenu: engineItems },
        { label: '自定义模型与命令…', click: () => openEngineDialog() },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '复位面板比例', accelerator: 'CmdOrCtrl+0', click: () => sendMenu('reset-split') },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    { role: 'windowMenu', label: '窗口' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ============================================================
 * 启动参数：--conv <对话日志路径>
 * 启动后自动把这份日志导进来（可以给多个）
 * ============================================================ */
function convPathsFromArgv(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--conv' && argv[i + 1]) out.push(argv[i + 1]);
  }
  return out;
}

const AUTO_CONV_PATHS = convPathsFromArgv(process.argv);

/* ============================================================
 * 窗口
 * ============================================================ */
function createWindow() {
  // 按屏幕工作区算窗口大小并居中，避免超出屏幕边缘
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1280, Math.max(880, wa.width - 80));
  const height = Math.min(860, Math.max(560, wa.height - 80));

  win = new BrowserWindow({
    width,
    height,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#eef1f5',
    title: '双面板 · 共识文档工作台',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.center(); // 摆在屏幕中间，别顶在边上
    win.show();
  });

  // 启动参数里带了日志：渲染层就绪后自动导进来
  if (AUTO_CONV_PATHS.length) {
    win.webContents.on('did-finish-load', () => {
      win.webContents.send('conv:autoload', AUTO_CONV_PATHS);
    });
  }

  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* 暴露给自动化自检使用的纯函数 */
module.exports = { loadDocsFromPaths, readDoc, decodeBuffer, encodeText, openEngineDialog, openPicker };
