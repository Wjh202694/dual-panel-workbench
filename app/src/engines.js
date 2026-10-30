'use strict';
/**
 * 提炼引擎的**清单**和**默认设置** —— 纯数据 + 纯规则，不跑任何东西。
 *
 * 单独放一个模块的原因：
 *  - 「有哪些引擎、默认值是什么」是数据，引擎跑起来是另一回事（那在 conv/distill.js）；
 *  - 设置存到哪儿是第三回事（那在 src/settings.js）。
 * 之前这三件事互相引用，改一处要动三处。
 */

/** 可选引擎 */
const ENGINES = [
  { id: 'opencode', label: 'opencode（推荐 · 免费模型）', defaultModel: 'magpie/auto/beam-free' },
  { id: 'claude', label: 'Claude Code CLI', defaultModel: '' },
  { id: 'custom', label: '自定义命令（从 stdin 读提示词）', defaultModel: '' },
  { id: 'api', label: 'API 调用（OpenAI 兼容 / Anthropic）', defaultModel: '' },
];

const DEFAULT_SETTINGS = {
  engine: 'opencode',
  model: 'magpie/auto/beam-free',
  customCommand: '',
  apiBaseUrl: '',
  apiKey: '',
  apiFormat: 'openai', // 'openai' | 'anthropic'
  timeoutMs: 180000,
};

/**
 * 把一份设置整理成合法的样子
 *
 * 规则只有这几条：引擎得是清单里的那个；没填模型就用该引擎的默认模型；
 * 接口格式只认 openai / anthropic；几个字符串字段去掉首尾空白。
 *
 * @param {Object} settings 待整理的设置
 * @returns {Object} 整理后的设置（不改原对象）
 */
function normalizeSettings(settings) {
  const s = { ...(settings || {}) };

  if (!ENGINES.some((e) => e.id === s.engine)) s.engine = DEFAULT_SETTINGS.engine;
  if (!s.model) {
    const preset = ENGINES.find((e) => e.id === s.engine);
    s.model = (preset && preset.defaultModel) || '';
  }
  // 接口格式只认这两种
  if (s.apiFormat !== 'anthropic') s.apiFormat = 'openai';

  s.apiBaseUrl = String(s.apiBaseUrl || '').trim();
  s.apiKey = String(s.apiKey || '').trim();
  s.model = String(s.model || '').trim();
  s.customCommand = String(s.customCommand || '').trim();

  return s;
}

module.exports = { ENGINES, DEFAULT_SETTINGS, normalizeSettings };
