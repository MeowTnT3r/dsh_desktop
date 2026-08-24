'use strict';

// unit-file-changes-highlight.test.js — K28 侧边栏编辑器「agent 改动行内高亮」单测。
//
// 覆盖三块：
//  1) 内嵌覆盖行分类 highlightNewLines（dsh-client-file-changes 纯函数）：
//     把 newText 每一行映射成 ctx/add/mod，并统计 removed(红)/added(绿)/changed(黄)，
//     不设上下文窗口、kinds 长度恒等于当前文件行数。
//  2) 按 path 查询 queryFileHighlight：路径归一命中 / 未命中 / 同路径多笔
//     累计（首条 oldText → 末条 newText）/ delete 场景。
//  3) 数据打通：window.__dshFileChanges 全局 store（ensureFileChangesStore）
//     set → queryFileHighlight → subscribe 通知链路；以及 better-sidebar 编译
//     产物（lib/client-editor.js）内联了装饰机制 + 三色 class 的产物契约。
//
// 运行：node --test scripts/test/unit-file-changes-highlight.test.js
//（不依赖内核 / DOM / 网络；客户端 bundle 用 vm 物化，纯函数走 __internals。）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// vm 物化出的 bundle 返回跨 realm 的数组/对象，统一经 JSON 往返归一为本地 realm。
const plain = (x) => JSON.parse(JSON.stringify(x));

const PLUGIN_DIR = path.join(__dirname, '..', '..', 'assets', 'plugins');
const CLIENT_BUNDLE = path.join(PLUGIN_DIR, 'dsh-client-file-changes', 'lib', 'client.js');
const EDITOR_CHUNK = path.join(PLUGIN_DIR, 'dsh-better-sidebar', 'lib', 'client-editor.js');
const HIGHLIGHT_HELPER = path.join(PLUGIN_DIR, 'dsh-better-sidebar', 'src', 'client', 'file-changes-highlight.ts');

/** 物化 dsh-client-file-changes 客户端 bundle，取 __internals 纯函数。 */
function loadClientInternals() {
  let captured = null;
  const sandbox = { window: { __ModuleLoader__: { load: (reg) => { captured = reg; } } } };
  vm.runInNewContext(fs.readFileSync(CLIENT_BUNDLE, 'utf8'), sandbox, { filename: CLIENT_BUNDLE });
  assert.ok(captured && typeof captured.factory === 'function', '应经 __ModuleLoader__.load 注册 factory');

  const stub = () => {
    const fn = function () { return fn; };
    return new Proxy(fn, {
      get: (t, k) => {
        if (k === Symbol.toPrimitive) return () => '';
        if (k === Symbol.iterator) return function* iter() {}();
        return fn;
      },
      apply: () => fn,
    });
  };
  const mod = captured.factory(stub);
  assert.ok(mod && mod.__internals, '应导出 __internals 纯函数');
  return { internals: mod.__internals, window: sandbox.window };
}

// ---------------------------------------------------------------------------
// 1) highlightNewLines：内嵌覆盖行分类
// ---------------------------------------------------------------------------
test('highlightNewLines: create（空→有）→ 全部 add，added=N', () => {
  const { highlightNewLines } = loadClientInternals().internals;
  const hl = highlightNewLines('', 'line1\nline2\nline3');
  assert.deepEqual(plain(hl.kinds), ['add', 'add', 'add']);
  assert.equal(hl.added, 3);
  assert.equal(hl.removed, 0);
  assert.equal(hl.changed, 0);
});

test('highlightNewLines: delete（有→空）→ kinds 空，removed=N（红）', () => {
  const { highlightNewLines } = loadClientInternals().internals;
  const hl = highlightNewLines('line1\nline2', '');
  assert.deepEqual(plain(hl.kinds), []);
  assert.equal(hl.removed, 2);
  assert.equal(hl.added, 0);
  assert.equal(hl.changed, 0);
});

test('highlightNewLines: 单行修改 → 成对 mod（黄），前后 ctx', () => {
  const { highlightNewLines } = loadClientInternals().internals;
  const hl = highlightNewLines('a\nold\nz', 'a\nnew\nz');
  assert.deepEqual(plain(hl.kinds), ['ctx', 'mod', 'ctx']);
  assert.equal(hl.changed, 1);
  assert.equal(hl.added, 0);
  assert.equal(hl.removed, 0);
});

test('highlightNewLines: 中段插入 → mod 与 add 并存，kinds 长度 === 当前行数', () => {
  const { highlightNewLines } = loadClientInternals().internals;
  const hl = highlightNewLines('a\nx\nz', 'a\nX\nY\nZ\nz');
  assert.deepEqual(plain(hl.kinds), ['ctx', 'mod', 'add', 'add', 'ctx']);
  assert.equal(hl.changed, 1);
  assert.equal(hl.added, 2);
  assert.equal(hl.removed, 0);
  assert.equal(hl.kinds.length, 5, 'kinds 逐行对齐当前文件');
});

test('highlightNewLines: 纯中段插入一行（LCS 对齐）→ 该行为 add，其余 ctx', () => {
  const { highlightNewLines } = loadClientInternals().internals;
  const hl = highlightNewLines('a\nb', 'a\nc\nb');
  // 前缀/后缀启发式会误把 'b' 当 mod、把 'c' 当 add；LCS 正确识别为纯插入。
  assert.deepEqual(plain(hl.kinds), ['ctx', 'add', 'ctx']);
  assert.equal(hl.added, 1);
  assert.equal(hl.changed, 0);
  assert.equal(hl.removed, 0);
});

test('highlightNewLines: 中段删除一行（LCS 对齐）→ 无 mod，仅 removed 计数', () => {
  const { highlightNewLines } = loadClientInternals().internals;
  const hl = highlightNewLines('a\nx\nb', 'a\nb');
  assert.deepEqual(plain(hl.kinds), ['ctx', 'ctx']);
  assert.equal(hl.removed, 1);
  assert.equal(hl.added, 0);
  assert.equal(hl.changed, 0);
});

test('highlightNewLines: 无差异 → 全部 ctx', () => {
  const { highlightNewLines } = loadClientInternals().internals;
  const hl = highlightNewLines('a\nb\nc', 'a\nb\nc');
  assert.ok(hl.kinds.every((k) => k === 'ctx'));
  assert.deepEqual(plain(hl.kinds), ['ctx', 'ctx', 'ctx']);
  assert.equal(hl.changed, 0);
  assert.equal(hl.added, 0);
  assert.equal(hl.removed, 0);
});

test('highlightNewLines: kinds 长度恒等于 splitLines(newText).length（不变式）', () => {
  const { highlightNewLines, splitLines } = loadClientInternals().internals;
  const cases = [
    ['', ''],
    ['', 'x'],
    ['x', ''],
    ['a\nb', 'a\nB\nc'],
    ['1\n2\n3\n4', '1\n2\n3\n4'],
    ['x', 'x\ny\nz\nw'],
  ];
  for (const [oldText, newText] of cases) {
    const hl = highlightNewLines(oldText, newText);
    assert.equal(hl.kinds.length, splitLines(newText).length, `old=${JSON.stringify(oldText)} new=${JSON.stringify(newText)}`);
  }
});

// ---------------------------------------------------------------------------
// 2) queryFileHighlight：按 path 查询
// ---------------------------------------------------------------------------
test('queryFileHighlight: 未命中 → present:false', () => {
  const { queryFileHighlight } = loadClientInternals().internals;
  const changes = [{ seq: 1, time: 1, path: '/a.js', op: 'edit', oldText: 'x', newText: 'y' }];
  assert.deepEqual(plain(queryFileHighlight(changes, '/b.js')), { present: false });
  assert.deepEqual(plain(queryFileHighlight([], '/a.js')), { present: false });
});

test('queryFileHighlight: 命中 → 三色行分类 + op/seq/time 正确', () => {
  const { queryFileHighlight } = loadClientInternals().internals;
  const changes = [
    { seq: 7, time: 700, path: '/src/app.ts', op: 'create', oldText: '', newText: 'one\ntwo' },
  ];
  const hl = queryFileHighlight(changes, '/src/app.ts');
  assert.equal(hl.present, true);
  assert.equal(hl.op, 'create');
  assert.equal(hl.seq, 7);
  assert.equal(hl.time, 700);
  assert.deepEqual(plain(hl.kinds), ['add', 'add']);
  assert.equal(hl.added, 2);
});

test('queryFileHighlight: 路径归一命中（反斜杠 / 大小写）', () => {
  const { queryFileHighlight } = loadClientInternals().internals;
  const changes = [
    { seq: 1, time: 1, path: 'C:\\Proj\\SRC\\App.TS', op: 'edit', oldText: 'a', newText: 'A' },
  ];
  assert.equal(queryFileHighlight(changes, 'c:/proj/src/app.ts').present, true);
  assert.equal(queryFileHighlight(changes, 'C:/proj/src/APP.ts').present, true);
  assert.equal(queryFileHighlight(changes, 'C:/proj/other.ts').present, false);
});

test('queryFileHighlight: 同路径多笔 → 累计首条 oldText → 末条 newText', () => {
  const { queryFileHighlight } = loadClientInternals().internals;
  const changes = [
    { seq: 1, time: 1, path: '/a.js', op: 'create', oldText: '', newText: 'A' },
    { seq: 2, time: 2, path: '/a.js', op: 'edit', oldText: 'A', newText: 'A\nB' },
    { seq: 3, time: 3, path: '/a.js', op: 'edit', oldText: 'A\nB', newText: 'A\nB\nC' },
  ];
  const hl = queryFileHighlight(changes, '/a.js');
  assert.equal(hl.present, true);
  assert.equal(hl.count, 3);
  // 累计视图 = 空 → 'A\nB\nC'：三行全为新增。
  assert.deepEqual(plain(hl.kinds), ['add', 'add', 'add']);
  assert.equal(hl.added, 3);
});

test('queryFileHighlight: delete → kinds 空，removed 计数（红）', () => {
  const { queryFileHighlight } = loadClientInternals().internals;
  const changes = [
    { seq: 4, time: 400, path: '/gone.js', op: 'delete', oldText: 'a\nb\nc', newText: '' },
  ];
  const hl = queryFileHighlight(changes, '/gone.js');
  assert.equal(hl.present, true);
  assert.equal(hl.op, 'delete');
  assert.deepEqual(plain(hl.kinds), []);
  assert.equal(hl.removed, 3);
});

// ---------------------------------------------------------------------------
// 3) 数据打通：window.__dshFileChanges 全局 store + 产物契约
// ---------------------------------------------------------------------------
test('ensureFileChangesStore: set → queryFileHighlight → subscribe 通知链路', () => {
  const { internals, window } = loadClientInternals();
  const store = internals.ensureFileChangesStore();
  assert.equal(typeof store, 'object', '应创建 store 单例');
  assert.equal(window.__dshFileChanges, store, 'store 挂到 window 全局');

  let notified = 0;
  const unsubscribe = store.subscribe(() => { notified += 1; });

  // 初始：未命中。
  assert.deepEqual(plain(store.queryFileHighlight('s1', '/a.js')), { present: false });

  // 写入会话级 changes。
  store.set('s1', {
    changes: [{ seq: 1, time: 1, path: '/a.js', op: 'edit', oldText: 'x\nz', newText: 'x\nY\nz' }],
    truncated: false,
  });
  assert.equal(notified, 1, 'set 应通知订阅者');

  const hl = store.queryFileHighlight('s1', '/a.js');
  assert.equal(hl.present, true);
  assert.deepEqual(plain(hl.kinds), ['ctx', 'add', 'ctx']);

  // 其它会话隔离。
  assert.deepEqual(plain(store.queryFileHighlight('s2', '/a.js')), { present: false });

  // get 返回镜像数据。
  assert.equal(store.get('s1').changes.length, 1);
  assert.equal(store.get('s1').truncated, false);

  unsubscribe();
  store.set('s1', { changes: [], truncated: false });
  assert.equal(notified, 1, '退订后不再通知');
});

test('产物契约: better-sidebar 编辑器 chunk 内联装饰机制 + 三色 class', () => {
  const src = fs.readFileSync(EDITOR_CHUNK, 'utf8');
  // 装饰机制（StateField + effect + 构建函数）。
  assert.ok(src.includes('DiffHighlightEffect'), '装饰 effect');
  assert.ok(src.includes('diffHighlightField'), '装饰 StateField');
  assert.ok(src.includes('buildDiffDecorations'), '装饰构建函数');
  assert.ok(src.includes('readFileHighlight'), '读 window store 的桥接');
  assert.ok(src.includes('ensureDiffHighlightCss'), 'CSS 注入');
  assert.ok(src.includes('window.__dshFileChanges'), '读 window 全局');
  // 三色 class：绿增 + 黄改（红删为计数不渲染）；CSS 用 DSH 色 token。
  assert.ok(src.includes('dsh-editor-diff-add'), '新增行 class');
  assert.ok(src.includes('dsh-editor-diff-mod'), '修改行 class');
  assert.ok(src.includes('.dsh-editor-diff-add{background:color-mix(in srgb,var(--dsw-alias-state-success-primary)'), '绿增用 success 色');
  assert.ok(src.includes('.dsh-editor-diff-mod{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary)'), '黄改用 warn 色');
});

test('产物契约: dsh-client-file-changes bundle 内联 window store 与查询 API', () => {
  const src = fs.readFileSync(CLIENT_BUNDLE, 'utf8');
  assert.ok(src.includes('window.__dshFileChanges'), 'store 挂 window');
  assert.ok(src.includes('queryFileHighlight'), '按 path 查询 API');
  assert.ok(src.includes('highlightNewLines'), '行分类纯函数');
  assert.ok(src.includes('conversation.composer.dock'), '隐藏 dock occupant 挂载点');
  assert.ok(src.includes('file-changes-capture'), 'capture occupant id');
});

test('产物契约: better-sidebar src 助手文件存在且导出桥接函数', () => {
  const src = fs.readFileSync(HIGHLIGHT_HELPER, 'utf8');
  assert.ok(src.includes('export function readFileHighlight'), '读高亮桥接');
  assert.ok(src.includes('export function readFileChangesStore'), '读 store 桥接');
  assert.ok(src.includes('export function ensureDiffHighlightCss'), 'CSS 注入');
  assert.ok(src.includes('export function highlightKindClass'), 'class 映射');
});
