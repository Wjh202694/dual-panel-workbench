/**
 * Markdown 所见即所得编辑器（Milkdown）
 * - 解析：CommonMark + GFM（表格、删除线、任务列表）
 * - 输出：标准 Markdown 源码，写回磁盘后 agent 可直接阅读
 */
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { history } from '@milkdown/kit/plugin/history';
import { replaceAll, callCommand } from '@milkdown/kit/utils';

export async function createMdEditor(host, initialContent, onChange) {
  let current = initialContent ?? '';

  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host);
      ctx.set(defaultValueCtx, current);
    })
    .use(commonmark)
    .use(gfm)
    .use(listener)
    .use(history)
    .create();

  // 监听器在 create 之后注册最稳妥（此时 listenerCtx 已注入）
  editor.ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
    current = markdown;
    onChange(markdown);
  });

  return {
    getContent: () => current,

    setContent(md) {
      current = md;
      editor.action(replaceAll(md, true));
    },

    /** 执行 Milkdown 命令，如 ToggleStrong / WrapInHeading(2) */
    exec(cmd, payload) {
      editor.action(callCommand(cmd, payload));
    },

    focus() {
      try {
        editor.ctx.get(editorViewCtx).focus();
      } catch (_) {
        /* 编辑器尚未挂载 */
      }
    },

    destroy() {
      try {
        editor.destroy();
      } catch (_) {
        /* 已销毁 */
      }
    },
  };
}
