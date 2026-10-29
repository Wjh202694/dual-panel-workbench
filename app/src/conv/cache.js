'use strict';
/**
 * 提炼产物的落盘与缓存
 *
 * 提炼结果写到日志旁边：<日志名>.recap.md
 * 这个文件既是给人看的产物，也是缓存 —— 再导入同一个日志时直接复用，不再调用 agent。
 *
 * 文件里每轮用锚点注释标记：
 *   <!-- recap:1 -->
 *   - ...
 *   <!-- /recap:1 -->
 */

const path = require('path');
const fsp = require('fs/promises');

const ANCHOR_RE = /^<!--\s*recap:(\d+)\s*-->$/;

/** 日志文件路径 → 提炼产物路径 */
function recapPathFor(logPath) {
  const dir = path.dirname(logPath);
  const base = path.basename(logPath);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return path.join(dir, `${stem}.recap.md`);
}

/** 读取缓存：返回 { 轮次号 -> 要点数组 } */
async function readCache(logPath) {
  const file = recapPathFor(logPath);
  try {
    const text = await fsp.readFile(file, 'utf8');
    return parseCache(text);
  } catch (_) {
    return {};
  }
}

/** 解析 recap.md 的正文，取出各轮要点 */
function parseCache(text) {
  const recaps = {};
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.trim().match(ANCHOR_RE);
    if (m) {
      current = Number(m[1]);
      recaps[current] = [];
      continue;
    }
    if (line.trim() === '<!-- /recap -->') {
      current = null;
      continue;
    }
    if (current == null) continue;
    const b = line.match(/^[-*•·]\s+(.*)$/);
    if (b) recaps[current].push(b[1].trim());
    else if (line.trim()) recaps[current].push(line.trim());
  }
  return recaps;
}

/** 把各轮要点写回 recap.md */
async function writeCache(logPath, payload) {
  const { rounds = [], engine = '', source = '' } = payload || {};
  const file = recapPathFor(logPath);

  const lines = [];
  lines.push('<!-- 对话 recap：由「双面板 · 共识文档工作台」自动提炼 -->');
  if (source) lines.push(`<!-- 来源：${path.basename(source)} -->`);
  if (engine) lines.push(`<!-- 引擎：${engine} -->`);
  lines.push('');
  lines.push('# 对话 recap');
  lines.push('');

  for (const r of rounds) {
    lines.push(`<!-- recap:${r.index} -->`);
    for (const b of r.bullets || []) lines.push('- ' + b);
    lines.push('<!-- /recap -->');
    lines.push('');
  }

  await fsp.writeFile(file, lines.join('\n'), 'utf8');
  return file;
}

/** 把一轮的要点并进已有缓存（只补没写过的轮次） */
async function upsertRound(logPath, index, bullets, meta = {}) {
  const file = recapPathFor(logPath);
  // 多轮可能同时提炼，读-改-写必须串行，否则后写的会把先写的覆盖掉
  return withLock(file, async () => {
    const existing = await readCache(logPath);
    const merged = { ...existing };
    // 这一轮以本次提炼结果为准：用户显式点了「重新提炼」时要能覆盖旧的
    // （避免"切换模型后重跑没反应"）。没被点名的那几轮保持原样。
    merged[index] = bullets;
    const rounds = Object.keys(merged)
      .map(Number)
      .sort((a, b) => a - b)
      .map((i) => ({ index: i, bullets: merged[i] }));
    const written = await writeCache(logPath, { rounds, engine: meta.engine, source: meta.source });
    return { file: written, recaps: merged };
  });
}

/** 每个文件的写操作排成一条链 */
const writeChains = new Map();

function withLock(file, fn) {
  const prev = writeChains.get(file) || Promise.resolve();
  const next = prev.then(fn, fn);
  writeChains.set(file, next.then(() => {}, () => {}));
  return next;
}

module.exports = { recapPathFor, readCache, writeCache, upsertRound, parseCache };
