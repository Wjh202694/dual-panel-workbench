'use strict';
/**
 * 应用设置的存取（存在 userData/settings.json，不占界面）
 *
 * 这一层只管「把 JSON 读出来 / 写回去」，
 * 「什么算合法的设置」在 src/engines.js 里。
 * 它放在 src/ 下面（不是 conv/ 下面），是因为对话那边和文档那边都要用。
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { DEFAULT_SETTINGS, normalizeSettings } = require('./engines');

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

/** 读全部设置（缺的补上默认值） */
function readSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    const j = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...(j && typeof j === 'object' ? j : {}) };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 改一部分设置并写回
 * @param {Object} patch 要改的字段
 * @returns {Object} 写完之后的完整设置
 */
function writeSettings(patch) {
  const next = normalizeSettings({ ...readSettings(), ...(patch || {}) });
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8');
  } catch (_) {
    /* 存不了就只在内存里用 */
  }
  return next;
}

module.exports = { readSettings, writeSettings, settingsFile };
