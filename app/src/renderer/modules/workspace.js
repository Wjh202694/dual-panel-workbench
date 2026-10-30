/**
 * 文档工作区：一次只显示一个文档，导入新的即替换当前的。
 *
 * 界面不显示任何"这是哪个文档"的信息——文件名、路径、大小、编码都不出现。
 *
 * 约定：
 *  - doc.original = 最近一次已知的「磁盘内容」
 *  - doc.current  = 编辑器当前内容
 *  - dirty = current !== original
 *  - 保存直接写回用户导入的原始路径（原地编辑，不产生副本）
 */
import { createMdEditor } from './md-editor.js';

const SAVE_DEBOUNCE = 900;

export function createWorkspace({ api, toaster, els }) {
  const { banner, bannerText, bannerReload, bannerKeep, editorHost, bottomContent } = els;

  let doc = null; // 当前文档
  let saveTimer = null;

  /** 文档区高度变了 → 让外层重算滚动条 */
  function notifyLayout() {
    if (els.onLayout) els.onLayout();
  }

  /* ---------------- 编辑视图 ---------------- */

  async function createView(d) {
    const el = document.createElement('div');
    el.className = 'docview';

    if (d.meta.kind === 'markdown') {
      el.classList.add('docview--md');
      editorHost.appendChild(el);
      const editor = await createMdEditor(el, d.original, (md) => onContentChanged(d, md));
      return { el, editor, textarea: null };
    }

    el.classList.add('docview--txt');
    const ta = document.createElement('textarea');
    ta.className = 'editor--text';
    ta.spellcheck = false;
    ta.value = d.original;
    el.appendChild(ta);
    editorHost.appendChild(el);

    /* 让 textarea 高度跟着内容长。
     *
     * 只在 requestAnimationFrame 里调是不够的：窗口被隐藏/最小化时
     * rAF 根本不触发，autoGrow 一次都没跑，textarea 停在最小高度，
     * 而 overflow:hidden 会把多出来的文字**直接裁掉** —— 表现就是
     * "txt 打开后文字有问题（少了/被截断）"。
     * 窗口重新显示后也不会自己补上，得敲一下键盘才恢复。
     *
     * 所以这里：同步先算一次 + rAF 再算一次 + 窗口恢复可见时再算一次
     * + 窗口尺寸变了要重算（宽度变了换行点也变了）。
     */
    function autoGrow() {
      ta.style.height = 'auto';
      const h = ta.scrollHeight;
      if (h > 0) ta.style.height = h + 'px'; // 隐藏时 scrollHeight 可能取不到，先别写
    }

    ta.addEventListener('input', () => {
      autoGrow();
      onContentChanged(d, ta.value);
    });

    autoGrow();
    requestAnimationFrame(autoGrow);

    const onVisible = () => {
      if (!document.hidden) autoGrow();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('resize', autoGrow);

    return { el, editor: null, textarea: ta, autoGrow, onVisible };
  }

  function onContentChanged(d, content) {
    d.current = content;
    if (d.suppress) {
      // 程序化写入（外部重载）：以编辑器归一化后的内容为准，避免立刻回写
      d.original = content;
      d.dirty = false;
    } else {
      d.dirty = content !== d.original;
      if (d.dirty) scheduleSave(d);
    }
  }

  /* ---------------- 保存 ---------------- */

  function scheduleSave(d) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveDoc(d), SAVE_DEBOUNCE);
  }

  async function saveDoc(d) {
    if (!d || d.saving) return false;
    if (!d.dirty) return true;

    d.saving = true;
    try {
      await api.saveDocument({
        filePath: d.meta.path,
        content: d.current,
        encoding: d.meta.encoding,
        bom: d.meta.bom,
      });
      d.original = d.current;
      d.dirty = false;
      d.saving = false;
      // 回读校验：以磁盘为准，防止写盘期间被别的进程改写而我们不知道
      try {
        const disk = await api.readDocument(d.meta.path);
        if (disk && disk.content !== d.current) {
          applyExternal(d, disk.content);
        }
      } catch (_) {
        /* 回读失败不阻塞，保存本身已成功 */
      }
      return true;
    } catch (err) {
      d.saving = false;
      const msg = String((err && err.message) || err || '未知错误');
      toaster.show(`保存失败：${msg}`, 'error', 6000);
      return false;
    }
  }

  function saveActive() {
    if (!doc) return;
    clearTimeout(saveTimer);
    if (!doc.dirty) return;
    saveDoc(doc);
  }

  /* ---------------- 代码改动视图（点卡片上的「code」才加载） ---------------- */

  let codeView = null;

  function codeLine(sign, l, approx) {
    const row = document.createElement('div');
    row.className = 'codeview__line codeview__line--' + (sign === '+' ? 'add' : 'del');
    const no = document.createElement('span');
    no.className = 'codeview__no';
    no.textContent = l && l.line != null ? String(l.line) : '';
    // 行号来自各自的版本：删除行是旧文件里的行号，新增行是新文件里的行号
    if (l && l.line != null) {
      no.title = approx
        ? '当前文件里第 ' + l.line + ' 行（这一轮之前的样子推不出来，只能按现在的文件估）'
        : (sign === '+' ? '改后第 ' : '改前第 ') + l.line + ' 行';
    }
    const tx = document.createElement('span');
    tx.className = 'codeview__text';
    tx.textContent = (l && l.text) || '';
    row.appendChild(no);
    row.appendChild(tx);
    return row;
  }

  function renderCodeView(payload) {
    const el = document.createElement('div');
    el.className = 'codeview';

    const files = (payload && payload.files) || [];
    const head = document.createElement('div');
    head.className = 'codeview__head';
    head.textContent = `第 ${payload && payload.index} 轮 · 改了 ${files.length} 个文件`;
    el.appendChild(head);

    /* 下面这块地方平时是放文档的，代码改动是暂借。文档还在就留个回去的路 */
    if (doc && doc.view) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'codeview__back';
      back.textContent = '回到文档';
      back.addEventListener('click', () => closeCode());
      head.appendChild(back);
    }

    for (const f of files) {
      const block = document.createElement('div');
      block.className = 'codeview__file';

      const path = document.createElement('div');
      path.className = 'codeview__path';
      path.textContent = f.rel || f.file || '';
      if (f.exists === false) {
        const tag = document.createElement('span');
        tag.className = 'codeview__tag';
        tag.textContent = '文件已不在';
        path.appendChild(tag);
      }
      if (f.beforeLines != null || f.afterLines != null) {
        const meta = document.createElement('span');
        meta.className = 'codeview__meta';
        meta.textContent =
          '改前 ' + (f.beforeLines == null ? '?' : f.beforeLines) +
          ' 行 → 改后 ' + (f.afterLines == null ? '?' : f.afterLines) + ' 行';
        path.appendChild(meta);
      }
      if (f.approx) {
        // 这一轮之前的内容推不出来：行号要么是按当前文件估的，要么根本算不出
        const anyNull = (f.changes || []).some((ch) =>
          (ch.removed || []).concat(ch.added || []).some((l) => l.line == null)
        );
        const tag = document.createElement('span');
        tag.className = 'codeview__tag codeview__tag--warn';
        tag.textContent = anyNull ? '这一轮的行号算不出来' : '行号是估的';
        tag.title = f.note || '这一轮之前的内容推不出来，行号只能按现在的文件估';
        path.appendChild(tag);
      }
      block.appendChild(path);

      for (const ch of f.changes || []) {
        const list = document.createElement('div');
        list.className = 'codeview__lines';
        for (const l of ch.removed || []) list.appendChild(codeLine('-', l, f.approx));
        for (const l of ch.added || []) list.appendChild(codeLine('+', l, f.approx));
        block.appendChild(list);
      }
      el.appendChild(block);
    }

    if (!files.length) {
      const none = document.createElement('div');
      none.className = 'codeview__none';
      none.textContent = '这一轮没有改文件';
      el.appendChild(none);
    }
    return el;
  }

  /** 在下方显示某一轮的代码改动（会暂时占住文档的位置） */
  function showCode(payload) {
    closeCode();
    const el = renderCodeView(payload);
    editorHost.hidden = false;
    editorHost.appendChild(el);
    codeView = el;
    bottomContent.dataset.filled = '1';
    bottomContent.style.height = '';
    if (doc && doc.view) doc.view.el.hidden = true;
    hideBanner();
    notifyLayout();
    const vp = document.getElementById('vp-bottom');
    if (vp) vp.scrollTop = 0;
  }

  /** 关掉代码改动视图，文档还在就把它放回来 */
  function closeCode() {
    if (!codeView) return;
    codeView.remove();
    codeView = null;
    if (doc && doc.view) doc.view.el.hidden = false;
    if (!doc) {
      editorHost.hidden = true;
      delete bottomContent.dataset.filled;
      bottomContent.style.height = '';
    }
    notifyLayout();
  }

  /* ---------------- 打开 / 关闭 ---------------- */

  async function openDoc(meta) {
    // 导入新文档 = 替换当前文档：先把当前的存盘，再销毁
    if (doc) {
      clearTimeout(saveTimer);
      if (doc.dirty) await saveDoc(doc);
      destroyDoc(doc);
    }
    closeCode(); // 代码改动视图让位给文档

    doc = {
      meta,
      original: meta.content,
      current: meta.content,
      dirty: false,
      saving: false,
      suppress: false,
      view: null,
    };

    /* 先把容器显示出来再建视图：视图一创建就要量自己的高度，
       容器还 hidden（display:none）的话量不到真实高度，
       txt 视图第一帧会停在最小高度（闪一下只有两行）。 */
    editorHost.hidden = false;
    bottomContent.dataset.filled = '1';
    bottomContent.style.height = '';

    doc.view = await createView(doc);
    // 建完再补一次：md 编辑器挂载后高度可能变过
    if (doc.view && doc.view.autoGrow) doc.view.autoGrow();
    hideBanner();

    api.watchDocument(meta.path);
    api.rememberDocument(meta.path); // 记进「最近导入」，下次好找

    if (doc.view.editor) doc.view.editor.focus();
    else if (doc.view.textarea) doc.view.textarea.focus();

    notifyLayout();
  }

  function destroyDoc(d) {
    if (!d) return;
    if (d.view) {
      if (d.view.editor) d.view.editor.destroy();
      // txt 视图挂了两个全局监听，卸文档时一并摘掉，别越积越多
      if (d.view.onVisible) document.removeEventListener('visibilitychange', d.view.onVisible);
      if (d.view.textarea && d.view.autoGrow) window.removeEventListener('resize', d.view.autoGrow);
      d.view.el.remove();
    }
    api.unwatchDocument(d.meta.path);
  }

  function closeDoc() {
    if (!doc) return;
    clearTimeout(saveTimer);
    if (doc.dirty) saveDoc(doc);
    destroyDoc(doc);
    doc = null;
    closeCode();
    editorHost.hidden = true;
    delete bottomContent.dataset.filled;
    bottomContent.style.height = '';
    hideBanner();
    notifyLayout();
  }

  /* ---------------- 外部改动（agent 等在应用外写文件） ---------------- */

  function applyExternal(d, content) {
    d.suppress = true;
    if (d.view && d.view.editor) d.view.editor.setContent(content);
    else if (d.view && d.view.textarea) {
      d.view.textarea.value = content;
      if (d.view.autoGrow) d.view.autoGrow();
    }
    d.original = content;
    d.current = content;
    d.dirty = false;
    d.suppress = false;
  }

  function handleExternalChange({ path, content }) {
    if (!doc || doc.meta.path !== path) return;

    // 正在自己写盘：写盘过程同样会触发文件监听，此时的"外部改动"是自己的回声
    if (doc.saving) return;
    if (content === doc.current) return;  // 已经是一致的
    if (content === doc.original) return; // 无实质变化

    if (!doc.dirty) {
      // 本地没有未保存的改动 → 直接重新载入
      applyExternal(doc, content);
      toaster.show('文件在应用外被修改，已重新载入');
    } else {
      showBanner(content);
    }
  }

  function handleExternalRemoved({ path }) {
    if (!doc || doc.meta.path !== path) return;
    toaster.show('文件已被删除或移动', 'warn', 5000);
  }

  function showBanner(content) {
    bannerText.textContent = '文件在应用外被修改（可能是 agent 写入的）。你的改动尚未保存，请选择保留哪一份。';
    banner.hidden = false;
    banner.dataset.content = content;
  }

  function hideBanner() {
    banner.hidden = true;
    delete banner.dataset.content;
  }

  bannerReload.addEventListener('click', () => {
    if (!doc) return hideBanner();
    applyExternal(doc, banner.dataset.content || '');
    hideBanner();
  });

  bannerKeep.addEventListener('click', () => {
    if (!doc) return hideBanner();
    hideBanner();
    saveDoc(doc);
  });

  /* ---------------- 对外接口 ---------------- */

  async function importDocuments() {
    const res = await api.pickDocuments();
    if (!res) return;
    const { docs: incoming = [], skipped = [] } = res;

    if (incoming.length) {
      await openDoc(incoming[incoming.length - 1]);
    }
    if (skipped.length) {
      const names = skipped.map((p) => p.split(/[\\/]/).pop()).join('、');
      toaster.show(
        '已跳过不支持的文件（支持 .txt / .md，以及 .py / .js / .ts / .tsx / .jsx）：' + names,
        'warn',
        6000
      );
    }
  }

  api.onExternalChange(handleExternalChange);
  api.onExternalRemoved(handleExternalRemoved);

  return {
    importDocuments,
    saveActive,
    closeDoc,
    openDoc,
    showCode,
    closeCode,
    getDoc: () => doc,
  };
}
