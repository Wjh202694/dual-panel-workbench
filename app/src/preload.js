'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/**
 * 剥掉 Electron IPC 套的那层壳：
 * "Error invoking remote method 'engine:test': Error: API Key 没填"
 * → "API Key 没填"
 * 不然界面上显示出来的是一堆没用的前缀。
 */
function cleanIpcError(e) {
  const msg = String((e && e.message) || e || '未知错误');
  return msg
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(Error|Uncaught \w+ Error):\s*/, '')
    .trim();
}

/**
 * 渲染进程可用的能力（最小暴露面）
 */
contextBridge.exposeInMainWorld('api', {
  /* 打开系统文件框，选 txt / md */
  pickDocuments: () => ipcRenderer.invoke('doc:pick'),

  /* 写回原文件 */
  saveDocument: (payload) => ipcRenderer.invoke('doc:save', payload),

  /* 回读磁盘内容（存盘后校验） */
  readDocument: (filePath) => ipcRenderer.invoke('doc:read', filePath),

  /* 监听外部（agent 等）对文件的改动 */
  watchDocument: (filePath) => ipcRenderer.invoke('doc:watch', filePath),
  unwatchDocument: (filePath) => ipcRenderer.invoke('doc:unwatch', filePath),

  revealDocument: (filePath) => ipcRenderer.invoke('doc:reveal', filePath),
  openExternal: (filePath) => ipcRenderer.invoke('doc:open-external', filePath),

  appInfo: () => ipcRenderer.invoke('app:info'),

  /* 对话日志导入 */
  pickConversations: () => ipcRenderer.invoke('conv:pick'),
  loadConversation: (filePath) => ipcRenderer.invoke('conv:load', filePath),
  distillRound: (filePath, index) => ipcRenderer.invoke('conv:distill', { filePath, index }),
  recapFile: (filePath) => ipcRenderer.invoke('conv:recap-file', filePath),
  getEngineSettings: () => ipcRenderer.invoke('conv:settings:get'),
  setEngineSettings: (patch) => ipcRenderer.invoke('conv:settings:set', patch),
  listEngines: () => ipcRenderer.invoke('conv:engines'),

  /* 顶栏「切换模型」按键 */
  listModels: () => ipcRenderer.invoke('conv:models'),
  openEngineDialog: () => ipcRenderer.invoke('engine:open'),
  onEngineChanged: (cb) => ipcRenderer.on('engine:changed', (_e, cfg) => cb(cfg)),

  /* 「测试连接」：用当前填的配置跑一次引擎 */
  testEngine: (patch) => ipcRenderer.invoke('engine:test', patch).catch((e) => {
    throw new Error(cleanIpcError(e));
  }),

  /* 提炼引擎设置窗口 */
  closeSelf: () => ipcRenderer.send('engine:close'),

  /* 选择器窗口专用 */
  picker: {
    getData: () => ipcRenderer.invoke('picker:get-data'),
    choose: (item) => ipcRenderer.send('picker:choose', item),
    cancel: () => ipcRenderer.send('picker:cancel'),
    browse: (kind) => ipcRenderer.send('picker:browse', kind),
  },

  /* 启动参数指定要导入的对话日志 */
  onAutoLoadConversations: (cb) => ipcRenderer.on('conv:autoload', (_e, paths) => cb(paths)),

  /* 列表选择器（导入对话 / 导入文档） */
  openPicker: (kind) => ipcRenderer.invoke('picker:open', kind),
  onPickerResult: (cb) => ipcRenderer.on('picker:result', (_e, res) => cb(res)),

  /* 直接按路径打开文档（并记住它） */
  openDocumentByPath: (filePath) => ipcRenderer.invoke('doc:open-path', filePath),

  /* 记住打开过的文档，供「最近导入」清单用 */
  rememberDocument: (filePath) => ipcRenderer.invoke('doc:remember', filePath),

  onExternalChange: (cb) => ipcRenderer.on('doc:external-change', (_e, data) => cb(data)),
  onExternalRemoved: (cb) => ipcRenderer.on('doc:external-removed', (_e, data) => cb(data)),
  onMenuAction: (cb) => ipcRenderer.on('menu:action', (_e, action) => cb(action)),
});
