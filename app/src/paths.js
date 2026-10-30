'use strict';
/**
 * 路径换算的小工具。
 */

const path = require('path');

/**
 * 把一个绝对路径换成相对于 base 的路径
 *
 * 换不出来（比如不在 base 底下）就原样返回 —— 宁可给全路径，
 * 也不要给一个看着像相对路径、其实点不开的东西。
 *
 * @param {string} base 基准目录（一般是项目目录）
 * @param {string} target 要换算的路径
 * @returns {string}
 */
function relativeTo(base, target) {
  if (!base || !target) return target || '';
  const root = String(base).replace(/[\\/]+$/, '');
  if (!root) return target;

  const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  if (norm(target) === norm(root)) return path.basename(target);
  for (const sep of ['/', '\\']) {
    if (norm(target).startsWith(norm(root + sep))) return target.slice(root.length + 1);
  }
  return target;
}

module.exports = { relativeTo };
