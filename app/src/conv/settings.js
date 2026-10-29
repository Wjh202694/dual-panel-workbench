'use strict';
/**
 * 提炼引擎设置（存在 userData/settings.json，不占界面）
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { DEFAULT_SETTINGS, ENGINES } = require('./distill');

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    const j = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...(j && typeof j === 'object' ? j : {}) };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...(patch || {}) };
  // 校验引擎合法性
  if (!ENGINES.some((e) => e.id === next.engine)) next.engine = DEFAULT_SETTINGS.engine;
  if (!next.model) {
    const preset = ENGINES.find((e) => e.id === next.engine);
    next.model = (preset && preset.defaultModel) || '';
  }
  // 接口格式只认这两种
  if (next.apiFormat !== 'anthropic') next.apiFormat = 'openai';
  next.apiBaseUrl = String(next.apiBaseUrl || '').trim();
  next.apiKey = String(next.apiKey || '').trim();
  next.model = String(next.model || '').trim();
  next.customCommand = String(next.customCommand || '').trim();
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8');
  } catch (_) {
    /* 存不了就只在内存里用 */
  }
  return next;
}

module.exports = { readSettings, writeSettings, settingsFile };
