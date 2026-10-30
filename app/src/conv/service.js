'use strict';
/**
 * 对话导入的业务编排：解析 → 渲染素材 → 调用引擎提炼 → 落盘缓存
 */

const path = require('path');
const fsp = require('fs/promises');
const { parseTranscript, buildMaterial } = require('./parse-log');
const { computeRoundStates, fallbackChanges, diffLines, splitLines } = require('./code-diff');
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
 * 行号不是从日志里读来的（日志不记行号），而是把日志里的改动**回放**一遍，
 * 拿到「这一轮之前」和「这一轮之后」两个版本的文件内容，再做行级 diff：
 *  - 删除行的行号 = 它在**旧版本**里是第几行
 *  - 新增行的行号 = 它在**新版本**里是第几行
 * 拿磁盘上那份文件直接算是不行的 —— 它可能已经是好几轮之后的样子。
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

  // 这一轮碰过的文件
  const targets = [];
  for (const e of round.edits || []) {
    const f = String(e.file || '');
    if (f && !targets.includes(f)) targets.push(f);
  }

  const files = [];
  for (const file of targets) {
    // 这个文件在整份日志里的所有改动（跨轮次），按日志顺序
    const allEdits = [];
    for (const r of rounds) {
      for (const e of r.edits || []) {
        if (String(e.file || '') === file) {
          allEdits.push({ round: r.index, kind: e.kind, oldText: e.oldText, newText: e.newText });
        }
      }
    }

    const { exists, content } = await readFileIfExists(file);
    const states = computeRoundStates(allEdits, content);
    const st = states.get(index);

    const item = {
      file,
      rel: relativeTo(projectDir, file),
      exists,
      changes: [],
      beforeLines: null,
      afterLines: null,
      approx: false,
    };

    if (st) {
      item.beforeLines = splitLines(st.before).length;
      item.afterLines = splitLines(st.after).length;
      item.changes = diffLines(st.before, st.after);
      item.approx = !!st.approx;
    } else {
      // 推不出这一轮的内容 → 退回按当前文件估算，并标明是估算
      item.approx = true;
      item.changes = fallbackChanges(
        (round.edits || []).filter((e) => String(e.file || '') === file),
        content
      );
      item.afterLines = splitLines(content).length;
    }

    files.push(item);
  }

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

module.exports = { loadConversation, loadNewRounds, distillRound, loadRoundCode, readLogText };
