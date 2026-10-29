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
    rounds: rounds.map((r) => ({
      index: r.index,
      raw: r.raw,
      prompt: r.prompt,
      choices: r.choices,
      actions: r.actions,
      reply: r.reply,
      bullets: recaps[r.index] && recaps[r.index].length ? recaps[r.index] : null,
    })),
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

module.exports = { loadConversation, distillRound, readLogText };
