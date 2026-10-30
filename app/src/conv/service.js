'use strict';
/**
 * 对话导入的业务编排：解析 → 渲染素材 → 调用引擎提炼 → 落盘缓存
 *
 * 这一层只做编排：读日志、解析、调别的模块。
 * 具体算法都在别的模块里（解析在 parse-log、提炼在 distill、
 * 「这一轮改了哪些代码」在 code-diff），这里不重复实现。
 */

const path = require('path');
const fsp = require('fs/promises');
const { parseTranscript, buildMaterial } = require('./parse-log');
const codeDiff = require('./code-diff');
const distill = require('./distill');
const cache = require('./cache');
const { readSettings } = require('../settings');
const { readTextFile } = require('../text-file');

/**
 * 日志解析结果的缓存
 *
 * 日志可能几十 MB，点一次「code」就重解析一遍纯属浪费。
 * 用「大小 + 修改时间」当钥匙：文件没动就直接复用上次解析出来的轮次。
 * 日志被追加（边聊边写）时大小会变，缓存自然失效。
 */
const parsedCache = new Map();
const PARSED_CACHE_MAX = 8;

async function parseLog(logPath) {
  let st = null;
  try {
    st = await fsp.stat(logPath);
  } catch (_) {
    /* 读不到就当没有缓存 */
  }
  const hit = parsedCache.get(logPath);
  if (hit && st && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit;

  const text = await readTextFile(logPath);
  const { rounds, cwd } = parseTranscript(text);
  const entry = { size: st ? st.size : 0, mtimeMs: st ? st.mtimeMs : 0, rounds, cwd };

  if (parsedCache.size >= PARSED_CACHE_MAX) {
    parsedCache.delete(parsedCache.keys().next().value);
  }
  parsedCache.set(logPath, entry);
  return entry;
}

/**
 * 读入一个对话日志：切出各轮的「决策」素材，并带上已有的 recap 缓存
 */
async function loadConversation(logPath) {
  const { rounds } = await parseLog(logPath);
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
  const { rounds } = await parseLog(logPath);
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
  const { rounds } = await parseLog(logPath);
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
 * 这一层只管编排：读日志 → 解析 → 交给 code-diff 去算。
 * 怎么回放、怎么算行号，见 code-diff.js / code-state.js。
 *
 * @param {string} logPath 日志路径
 * @param {number} index 轮次序号（从 1 开始）
 */
async function loadRoundCode(logPath, index) {
  const { rounds, cwd } = await parseLog(logPath);
  return codeDiff.roundCode({ rounds, cwd, index });
}

module.exports = { loadConversation, loadNewRounds, distillRound, loadRoundCode };
