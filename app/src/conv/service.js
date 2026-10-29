'use strict';
/**
 * 对话导入的业务编排：解析 → 渲染素材 → 调用引擎提炼 → 落盘缓存
 */

const path = require('path');
const fsp = require('fs/promises');
const { parseTranscript, buildMaterial } = require('./parse-log');
const distill = require('./distill');
const cache = require('./cache');
const { readSettings } = require('./settings');

async function readLogText(logPath) {
  const buf = await fsp.readFile(logPath);
  // 日志基本都是 UTF-8；万一不是，用 decodeBuffer 兜一下
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    return buf.toString('utf8');
  }
}

/**
 * 读入一个对话日志：切出各轮的「决策」素材，并带上已有的 recap 缓存
 */
async function loadConversation(logPath) {
  const text = await readLogText(logPath);
  const { rounds } = parseTranscript(text);
  const recaps = await cache.readCache(logPath);
  return {
    path: logPath,
    name: path.basename(logPath),
    recapFile: cache.recapPathFor(logPath),
    rounds: rounds.map((r) => toRound(r, recaps)),
  };
}

/** 把解析出来的一轮整理成界面上要用的形状 */
function toRound(r, recaps) {
  return {
    index: r.index,
    raw: r.raw,
    prompt: r.prompt,
    choices: r.choices,
    actions: r.actions,
    reply: r.reply,
    bullets: recaps[r.index] && recaps[r.index].length ? recaps[r.index] : null,
  };
}

/**
 * 只取「比 afterIndex 更靠后的」那些轮次 —— 日志文件在导入之后还在往下写，
 * 点一下刷新就能把新长出来的轮次带出来，不用重新导入文件。
 *
 * @param {string} logPath 日志路径
 * @param {number} afterIndex 已经显示到第几轮（只带比它新的）
 * @param {number} limit 最多带几轮
 */
async function loadNewRounds(logPath, afterIndex, limit) {
  const text = await readLogText(logPath);
  const { rounds } = parseTranscript(text);
  const recaps = await cache.readCache(logPath);
  const from = Number(afterIndex) || 0;
  const max = Math.max(0, Number(limit) || 0);
  const fresh = rounds.filter((r) => r.index > from).slice(0, max);
  return {
    path: logPath,
    name: path.basename(logPath),
    total: rounds.length,
    rounds: fresh.map((r) => toRound(r, recaps)),
  };
}

/**
 * 提炼一轮：调引擎 → 拿要点 → 并进缓存文件
 */
async function distillRound(logPath, index) {
  const text = await readLogText(logPath);
  const { rounds } = parseTranscript(text);
  const round = rounds.find((r) => r.index === index);
  if (!round) throw new Error(`日志里找不到第 ${index} 轮`);

  const cfg = readSettings();
  const material = buildMaterial(round);
  const prompt = distill.buildPrompt(round, material);

  const stdout = await distill.runEngine(cfg, prompt, { cwd: path.dirname(logPath) });
  const textOut = distill.extractText(cfg.engine, stdout);
  const bullets = distill.toBullets(textOut);
  if (!bullets.length) throw new Error('引擎没有产出任何要点');

  const engineLabel = cfg.engine + (cfg.model ? ' · ' + cfg.model : '');
  const { file, recaps } = await cache.upsertRound(logPath, index, bullets, {
    engine: engineLabel,
    source: logPath,
  });

  return { index, bullets, recapFile: file, recaps };
}

/**
 * 某一轮改了哪些代码
 *
 * 日志里记的是「改动的文本」，行号要拿现在的磁盘内容去对：
 * 找到 newText 第一次出现的位置 → 起始行号；找不到就留空（null = 不知道）。
 *
 * @param {string} logPath 日志路径
 * @param {number} index 轮次序号（从 1 开始）
 */
async function loadRoundCode(logPath, index) {
  const text = await readLogText(logPath);
  const { rounds, cwd } = parseTranscript(text);
  const round = rounds.find((r) => r.index === index);
  if (!round) throw new Error(`日志里找不到第 ${index} 轮`);

  const projectDir = cwd || '';
  const edits = round.edits || [];
  if (!edits.length) return { index, cwd: projectDir, total: 0, files: [] };

  // 同一个文件只读一次盘；按文件分组，多条改动合成一个文件项
  const byFile = new Map();
  const contentCache = new Map();

  for (const e of edits) {
    const file = String(e.file || '');
    if (!file) continue;
    if (!byFile.has(file)) {
      byFile.set(file, {
        file,
        rel: relativeTo(projectDir, file),
        exists: false,
        changes: [],
      });
    }
    if (!contentCache.has(file)) contentCache.set(file, await readFileIfExists(file));
    const { exists, content } = contentCache.get(file);
    const item = byFile.get(file);
    item.exists = exists;
    item.changes.push(buildChange(e, content));
  }

  const files = Array.from(byFile.values());
  return { index, cwd: projectDir, total: files.length, files };
}

/** 读磁盘上的文件；读不到就当它不存在（文件被删了 / 路径变了） */
async function readFileIfExists(file) {
  try {
    const buf = await fsp.readFile(file);
    let content;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (_) {
      content = buf.toString('utf8');
    }
    return { exists: true, content };
  } catch (_) {
    return { exists: false, content: '' };
  }
}

/** 把绝对路径换成相对项目目录的路径；算不出来就还是绝对路径 */
function relativeTo(cwd, file) {
  if (!cwd || !file) return file || '';
  const base = String(cwd).replace(/[\\/]+$/, '');
  if (!base) return file;
  const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  if (norm(file) === norm(base)) return path.basename(file);
  for (const sep of ['/', '\\']) {
    if (norm(file).startsWith(norm(base + sep))) return file.slice(base.length + 1);
  }
  return file;
}

/**
 * 文本拆行：按换行切，缩进原样留着，只去掉行尾空白；
 * 末尾多出来的换行不算一行。
 */
function splitLines(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/).map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 在文件内容里找 newText 第一次出现的行号（1 起）；找不到返回 null */
function findStartLine(content, needle) {
  if (!needle) return null;
  const idx = content.indexOf(needle);
  if (idx < 0) return null;
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/** 一条改动 → { kind, added:[{line,text}], removed:[{line,text}] } */
function buildChange(edit, currentContent) {
  const kind = edit.kind;

  if (kind === 'write') {
    // 整个文件都是新内容，行号天然是 1..n
    const lines = splitLines(edit.newText);
    return {
      kind,
      added: lines.map((t, i) => ({ line: i + 1, text: t })),
      removed: [],
    };
  }

  if (kind === 'notebook') {
    // notebook 的行号对不上源码，给 null
    const lines = splitLines(edit.newText);
    return {
      kind,
      added: lines.map((t) => ({ line: null, text: t })),
      removed: [],
    };
  }

  // edit：新增块在现在的文件里第几行
  const addedLines = splitLines(edit.newText);
  const removedLines = splitLines(edit.oldText);
  const start = findStartLine(currentContent, edit.newText);
  return {
    kind: 'edit',
    added: addedLines.map((t, i) => ({ line: start === null ? null : start + i, text: t })),
    removed: removedLines.map((t, i) => ({ line: start === null ? null : start + i, text: t })),
  };
}

module.exports = { loadConversation, loadNewRounds, distillRound, loadRoundCode, readLogText };
