'use strict';
/**
 * 提炼模型预设：顶栏「切换模型」按键用
 *
 * 免费模型优先（用户成本敏感）。这些都是 opencode 的模型全名，
 * 漏掉 magpie/ 前缀会报 Model unavailable —— provider 名不是 opencode-zen。
 *
 * 额度会用尽（429），所以把 magpie/auto/beam-free 放在第一位当兜底。
 */

const MODEL_PRESETS = [
  {
    id: 'magpie/auto/beam-free',
    label: 'auto / beam-free',
    note: '默认 · 自动路由，别的模型没额度时的兜底',
  },
  {
    id: 'magpie/opencode-zen/glm-5.3-flash-free',
    label: 'glm-5.3-flash-free',
    note: '免费 · 中文表达好',
  },
  {
    id: 'magpie/opencode-zen/deepseek-v4.1-flash-free',
    label: 'deepseek-v4.1-flash-free',
    note: '免费 · 代码理解强',
  },
  {
    id: 'magpie/opencode-zen/mimo-v2.6-flash-free',
    label: 'mimo-v2.6-flash-free',
    note: '免费 · 结构化输出稳',
  },
  {
    id: 'magpie/opencode-zen/space-bunny-free',
    label: 'space-bunny-free',
    note: '免费 · 轻量快',
  },
];

/** 按钮上显示的短名 */
function shortLabel(id) {
  const hit = MODEL_PRESETS.find((m) => m.id === id);
  if (hit) return hit.label;
  if (!id) return '未设置';
  const tail = String(id).split('/').pop();
  return tail.length > 22 ? tail.slice(0, 21) + '…' : tail;
}

module.exports = { MODEL_PRESETS, shortLabel };
