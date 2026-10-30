'use strict';
/**
 * 读文本文件的统一入口。
 *
 * 日志和源码文件都是「UTF-8 为主、偶尔不是」的文本：
 * 先严格按 UTF-8 解，解不出来再退回宽松解码。
 * 放在一处，是为了别的地方不用各抄一份解码逻辑。
 */

const fsp = require('fs/promises');

/** 按 UTF-8 解码；解不出来就宽松一点（可能夹了 GBK 或 BOM） */
function decode(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    return buf.toString('utf8');
  }
}

/**
 * 读一个文本文件
 * @param {string} file 文件路径
 * @returns {Promise<string>} 文件内容；读不到会抛错
 */
async function readTextFile(file) {
  return decode(await fsp.readFile(file));
}

/**
 * 读一个文本文件；读不到就当它不存在（文件被删了 / 路径变了）
 * @param {string} file 文件路径
 * @returns {Promise<{exists: boolean, content: string}>}
 */
async function readTextFileIfExists(file) {
  try {
    return { exists: true, content: decode(await fsp.readFile(file)) };
  } catch (_) {
    return { exists: false, content: '' };
  }
}

module.exports = { readTextFile, readTextFileIfExists };
