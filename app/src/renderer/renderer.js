/**
 * 渲染进程入口：装配双面板、滚动条、分割线与文档工作区
 */
import './styles.css';
import { initScrollPanel } from './modules/scrollbar.js';
import { initSplit } from './modules/split.js';
import { createToaster } from './modules/toast.js';
import { createWorkspace } from './modules/workspace.js';
import { createConversations } from './modules/conversations.js';
import { createModelMenu } from './modules/model-menu.js';

const $ = (id) => document.getElementById(id);

/* ---------------- 右侧独立滚动栏（上下各一条，互不影响） ---------------- */
const topPanel = initScrollPanel({
  viewport: $('vp-top'),
  content: $('ct-top'),
  seg: $('sb-top'),
  thumb: $('th-top'),
  pct: $('pct-top'),
});

const bottomPanel = initScrollPanel({
  viewport: $('vp-bottom'),
  content: $('ct-bottom'),
  seg: $('sb-bottom'),
  thumb: $('th-bottom'),
  pct: $('pct-bottom'),
  blank: true, // 未导入文档时，下方面板保持与 Demo 一样的可滚动空白
});

/* ---------------- 可拖动中缝 ---------------- */
initSplit({
  split: $('split'),
  label: $('splitRatio'),
  screen: document.querySelector('.app'),
  topEl: document.querySelector('.panel--top'),
  bottomEl: document.querySelector('.panel--bottom'),
  topbar: document.querySelector('.topbar'),
  onChange: () => {
    topPanel.metrics();
    bottomPanel.metrics();
  },
});

/* ---------------- 文档工作区 ---------------- */
const toaster = createToaster($('toasts'));

const workspace = createWorkspace({
  api: window.api,
  toaster,
  els: {
    banner: $('banner'),
    bannerText: $('banner-text'),
    bannerReload: $('banner-reload'),
    bannerKeep: $('banner-keep'),
    editorHost: $('editor'),
    bottomContent: $('ct-bottom'),
    onLayout: () => bottomPanel.metrics(),
  },
});

/* ---------------- 对话区 ---------------- */
const conversations = createConversations({
  api: window.api,
  toaster,
  onLayout: () => topPanel.metrics(),
  // 点卡片上的「code」才加载这一轮的代码改动，显示在下方的大长方形里
  onShowCode: (payload) => workspace.showCode(payload),
});

/* ---------------- 顶栏 ---------------- */
$('btn-import-doc').addEventListener('click', () => {
  window.api.openPicker('doc');
});

$('btn-import-conv').addEventListener('click', () => {
  window.api.openPicker('conv');
});

/* 选择器选完了：该干什么干什么 */
window.api.onPickerResult(async (res) => {
  if (!res) return;
  try {
    if (res.kind === 'conv') {
      await conversations.openLogByPath(res.path);
    } else if (res.kind === 'doc') {
      const meta = await window.api.openDocumentByPath(res.path);
      await workspace.openDoc(meta);
    } else if (res.kind === 'doc-picked') {
      const docs = res.docs || [];
      if (docs.length) await workspace.openDoc(docs[docs.length - 1]);
      if (res.skipped && res.skipped.length) {
        const names = res.skipped.map((p) => p.split(/[\\/]/).pop()).join('、');
        toaster.show(
          '已跳过不支持的文件（支持 .txt / .md，以及 .py / .js / .ts / .tsx / .jsx）：' + names,
          'warn',
          6000
        );
      }
    }
  } catch (err) {
    toaster.show('打开失败：' + ((err && err.message) || err), 'error');
  }
});

/* ---------------- 右上角：切换提炼模型 ---------------- */
createModelMenu({
  api: window.api,
  toaster,
  els: {
    btn: $('btn-model'),
    name: $('model-name'),
    menu: $('model-menu'),
    list: $('model-list'),
    more: $('model-more'),
  },
});

/* ---------------- 右上角：刷新对话（带出新增的轮次） ---------------- */
const refreshBtn = $('btn-refresh');
refreshBtn.addEventListener('click', async () => {
  if (refreshBtn.disabled) return;
  refreshBtn.disabled = true;
  refreshBtn.classList.add('is-busy');
  try {
    await conversations.refresh();
  } catch (err) {
    toaster.show('刷新失败：' + ((err && err.message) || err), 'error');
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('is-busy');
  }
});

/* ---------------- 菜单动作 ---------------- */
window.api.onMenuAction((action) => {
  if (action === 'import-doc') window.api.openPicker('doc');
  else if (action === 'import-conv') window.api.openPicker('conv');
  else if (action === 'distill-all') conversations.distillAll();
  else if (action === 'save') workspace.saveActive();
  else if (action === 'reveal') {
    const d = workspace.getDoc();
    if (d) window.api.revealDocument(d.meta.path);
  } else if (action === 'reset-split') {
    $('split').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
  }
});

/* ---------------- 快捷键兜底（菜单快捷键之外的场景） ---------------- */
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 's') {
    e.preventDefault();
    workspace.saveActive();
  } else if (k === 'o' && e.shiftKey) {
    e.preventDefault();
    window.api.openPicker('conv');
  } else if (k === 'o') {
    e.preventDefault();
    window.api.openPicker('doc');
  }
});

/* 启动参数指定了对话日志：自动导进来 */
window.api.onAutoLoadConversations(async (paths) => {
  for (const p of paths || []) {
    try {
      await conversations.openLogByPath(p);
    } catch (err) {
      toaster.show('导入失败：' + (err && err.message ? err.message : err), 'error');
    }
  }
});

/* ---------------- 启动 ---------------- */
window.api.appInfo().then((info) => {
  document.title = `双面板 · 共识文档工作台  v${info.version}`;
});

/* 调试钩子：供自动化自检与后续功能使用 */
window.__app = { workspace, toaster, conversations };
