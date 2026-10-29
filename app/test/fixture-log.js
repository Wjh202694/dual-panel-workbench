'use strict';
/**
 * 造一份合成的对话日志（JSONL），用于自检。
 * 里面全是虚构内容，不含任何真实会话信息。
 *
 * 顺序刻意还原真实的日志形态：中途插话、压缩摘要、跨会话转发、系统通知，
 * 都要被解析成"只有人写的那几句"。
 */

const FIXTURE = [
  /* ---------- 第 1 轮 ---------- */
  {
    type: 'user',
    origin: { kind: 'human' },
    message: { role: 'user', content: '把这个页面改成双栏布局，左边列表右边详情' },
  },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: '我先看看现有代码结构。' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/pages/list.tsx' } },
        { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'layout', path: 'src' } },
      ],
    },
  },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 't3',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: '用哪种方案？',
                header: '方案',
                options: [
                  { label: 'CSS Grid', description: '改动最小，只动样式文件' },
                  { label: 'Flex 布局', description: '兼容性最好，但要调若干子元素' },
                ],
              },
            ],
          },
        },
      ],
    },
  },

  /* 用户回答了 agent 的提问（AskUserQuestion 的选项来自上一轮） */
  {
    type: 'user',
    origin: { kind: 'human' },
    message: { role: 'user', content: '用 CSS Grid' },
  },

  /* ---------- 中途插话：用户在 agent 干活时又发了一条 ----------
     日志里不是 user 记录，而是 attachment / queued_command。 */
  {
    type: 'attachment',
    attachment: {
      type: 'queued_command',
      prompt: '然后右上角的图标删去',
      origin: { kind: 'human' },
      humanTurn: true,
      timestamp: '2026-10-28T14:11:05.381Z',
    },
  },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't4', name: 'Edit', input: { file_path: 'src/pages/list.tsx' } },
        { type: 'tool_use', id: 't5', name: 'Bash', input: { command: 'npm run build' } },
        { type: 'text', text: '改完了，构建通过。' },
      ],
    },
  },

  /* ---------- 下面这些是系统噪音，不该进「决策」 ---------- */
  { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
  { type: 'user', message: { role: 'user', content: '<local-command-stdout>cleared</local-command-stdout>' } },
  {
    type: 'user',
    sourceToolAssistantUUID: 't4',
    message: { role: 'user', content: 'The file src/pages/list.tsx has been updated.' },
  },
  {
    type: 'assistant',
    isSidechain: true,
    message: { role: 'assistant', content: [{ type: 'text', text: '子代理的话，不算一轮。' }] },
  },
  /* 压缩摘要：系统产物，不是人写的 */
  {
    type: 'user',
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    message: { role: 'user', content: 'This session is being continued from a previous conversation...' },
  },
  /* 别的会话转过来的消息：origin 是 peer，不是人 */
  {
    type: 'user',
    isMeta: true,
    origin: { kind: 'peer', from: 'abc123', name: 'general-purpose' },
    message: { role: 'user', content: 'Another Claude session sent a message:\n<agent-message from="x">' },
  },
  /* 系统通知 */
  {
    type: 'user',
    isMeta: true,
    message: { role: 'user', content: '## Context Usage\n\n**Model:** some-model' },
  },
  /* 任务通知转来的插话：origin 不是 human，不算人的决策 */
  {
    type: 'attachment',
    attachment: {
      type: 'queued_command',
      prompt: '<task-notification>\n<task-id>abc</task-id>\n</task-notification>',
      origin: { kind: 'task-notification', producer: 'session-task' },
    },
  },
];

/** 生成一份合成日志文件 */
function writeFixture(filePath) {
  const lines = FIXTURE.map((r) => JSON.stringify(r)).join('\n');
  require('fs').writeFileSync(filePath, lines + '\n', 'utf8');
  return filePath;
}

module.exports = { FIXTURE, writeFixture };
