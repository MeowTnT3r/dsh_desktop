'use strict';

// unit-file-changes-diff.test.js — K26 文件变更「diff 记录 + 演示高亮」单测。
//
// 覆盖两块：
//  1) diff 记录（改动前后对比正确）：
//     - dsh-file-changes 投影（host）把 tool/result 的 meta.diffs 折叠成
//       { seq, time, path, op, oldText, newText } 的 before→after 历史；
//     - dsh-client-file-changes 的 groupChanges 把同一路径的多笔变更聚合成
//       「首条 oldText → 末条 newText」的累计视图，同时保留 items 全量历史。
//  2) 演示高亮（新增/删除/修改三类行的 class）：
//     - diffRows 生成 ctx/del/add/mod 四类行（mod 成对 = 黄色修改）；
//     - diffKindClass 映射到 .dsh-fc-add / .dsh-fc-del / .dsh-fc-mod class；
//     - CSS 三色高亮内联进 bundle（绿增/红删/黄改）。
//
// 运行：node --test scripts/test/unit-file-changes-diff.test.js
//（不依赖内核 / DOM / 网络；客户端 bundle 用 vm 物化，投影用动态 import。）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

// vm 物化出的 bundle 返回跨 realm 的数组/对象（原型不同于本测试 realm），
// deepStrictEqual 会对原型做严格比较，故统一经 JSON 往返归一为本地 realm。
const plain = (x) => JSON.parse(JSON.stringify(x));

const PLUGIN_DIR = path.join(__dirname, '..', '..', 'assets', 'plugins');
const CLIENT_BUNDLE = path.join(PLUGIN_DIR, 'dsh-client-file-changes', 'lib', 'client.js');
const HOST_INDEX = path.join(PLUGIN_DIR, 'dsh-file-changes', 'lib', 'index.js');

// ---------------------------------------------------------------------------
// 物化客户端 bundle（手写 ModuleLoader 包），取 __internals 纯函数。
// ---------------------------------------------------------------------------
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
  return mod.__internals;
}

// ---------------------------------------------------------------------------
// 1) 演示高亮：diffRows / diffStats / diffKindClass
// ---------------------------------------------------------------------------
test('diffRows: create（空→有）→ 全部 add，无 del/mod', () => {
  const { diffRows, diffStats } = loadClientInternals();
  const rows = diffRows('', 'line1\nline2\nline3');
  assert.deepEqual(plain(rows.map((r) => r.kind)), ['add', 'add', 'add']);
  assert.deepEqual(plain(rows.map((r) => r.text)), ['line1', 'line2', 'line3']);
  assert.deepEqual(plain(diffStats(rows)), { add: 3, del: 0, mod: 0, added: 3, removed: 0 });
});

test('diffRows: delete（有→空）→ 全部 del，无 add/mod', () => {
  const { diffRows, diffStats } = loadClientInternals();
  const rows = diffRows('line1\nline2', '');
  assert.deepEqual(plain(rows.map((r) => r.kind)), ['del', 'del']);
  assert.deepEqual(plain(rows.map((r) => r.text)), ['line1', 'line2']);
  assert.deepEqual(plain(diffStats(rows)), { add: 0, del: 2, mod: 0, added: 0, removed: 2 });
});

test('diffRows: 单行修改 → 成对 mod（先旧后新），前后上下文为 ctx', () => {
  const { diffRows, diffStats } = loadClientInternals();
  const rows = diffRows('a\nold\nz', 'a\nnew\nz');
  assert.deepEqual(plain(rows.map((r) => r.kind)), ['ctx', 'mod', 'mod', 'ctx']);
  assert.deepEqual(plain(rows.map((r) => r.text)), ['a', 'old', 'new', 'z']);
  const st = diffStats(rows);
  assert.equal(st.mod, 1, '修改行成对，各计一次');
  assert.equal(st.add, 0);
  assert.equal(st.del, 0);
  assert.equal(st.added, 1);
  assert.equal(st.removed, 1);
});

test('diffRows: 新增多于删除 → 成对为 mod，剩余为 add', () => {
  const { diffRows, diffStats } = loadClientInternals();
  const rows = diffRows('a\nx\nz', 'a\nX\nY\nZ\nz');
  assert.deepEqual(plain(rows.map((r) => r.kind)), ['ctx', 'mod', 'mod', 'add', 'add', 'ctx']);
  assert.deepEqual(plain(rows.map((r) => r.text)), ['a', 'x', 'X', 'Y', 'Z', 'z']);
  const st = diffStats(rows);
  assert.equal(st.mod, 1);
  assert.equal(st.add, 2);
  assert.equal(st.del, 0);
  assert.equal(st.added, 3);
  assert.equal(st.removed, 1);
});

test('diffRows: 删除多于新增 → 成对为 mod，剩余为 del', () => {
  const { diffRows, diffStats } = loadClientInternals();
  const rows = diffRows('a\nx\ny\nz', 'a\nX\nz');
  assert.deepEqual(plain(rows.map((r) => r.kind)), ['ctx', 'mod', 'mod', 'del', 'ctx']);
  assert.deepEqual(plain(rows.map((r) => r.text)), ['a', 'x', 'X', 'y', 'z']);
  const st = diffStats(rows);
  assert.equal(st.mod, 1);
  assert.equal(st.add, 0);
  assert.equal(st.del, 1);
  assert.equal(st.added, 1);
  assert.equal(st.removed, 2);
});

test('diffRows: 无差异 → 全部 ctx（或空）', () => {
  const { diffRows, diffStats } = loadClientInternals();
  const rows = diffRows('a\nb\nc', 'a\nb\nc');
  assert.ok(rows.every((r) => r.kind === 'ctx'), '无差异应全部为上下文');
  assert.deepEqual(plain(rows.map((r) => r.text)), ['a', 'b', 'c']);
  assert.deepEqual(plain(diffStats(rows)), { add: 0, del: 0, mod: 0, added: 0, removed: 0 });
});

test('diffKindClass: 新增/删除/修改/上下文映射到对应高亮 class', () => {
  const { diffKindClass } = loadClientInternals();
  assert.equal(diffKindClass('add'), 'dsh-fc-add');
  assert.equal(diffKindClass('del'), 'dsh-fc-del');
  assert.equal(diffKindClass('mod'), 'dsh-fc-mod');
  assert.equal(diffKindClass('ctx'), 'dsh-fc-ctx');
  assert.equal(diffKindClass('anything-else'), 'dsh-fc-mod', '未知类型兜底为 mod');
});

// ---------------------------------------------------------------------------
// 2) 产物契约：三色高亮 CSS 与变更历史 UI 内联进 bundle
// ---------------------------------------------------------------------------
test('产物契约: 绿增/红删/黄改三类 class + 变更历史结构内联', () => {
  const src = fs.readFileSync(CLIENT_BUNDLE, 'utf8');
  assert.ok(src.includes('.dsh-fc-add{'), '新增行绿色 class');
  assert.ok(src.includes('.dsh-fc-del{'), '删除行红色 class');
  assert.ok(src.includes('.dsh-fc-mod{'), '修改行黄色 class');
  assert.ok(src.includes('--dsw-alias-state-warn-primary'), '黄色修改用 warn 色 token');
  assert.ok(src.includes('.dsh-fc-hist{'), '变更历史容器');
  assert.ok(src.includes('.dsh-fc-hist-row{'), '历史记录行');
  assert.ok(src.includes('变更历史（改动前 → 后）'), '历史分区标题');
});

// ---------------------------------------------------------------------------
// 3) diff 记录：groupChanges 聚合（首条 oldText → 末条 newText + 全量 items）
// ---------------------------------------------------------------------------
test('groupChanges: 同路径多笔变更 → 累计视图 + 保留全量历史 items', () => {
  const { groupChanges } = loadClientInternals();
  const changes = [
    { seq: 1, time: 1, path: '/a.js', op: 'create', oldText: '', newText: 'A' },
    { seq: 2, time: 2, path: '/a.js', op: 'edit', oldText: 'A', newText: 'AB' },
    { seq: 3, time: 3, path: '/b.js', op: 'edit', oldText: 'x', newText: 'y' },
  ];
  const groups = groupChanges(changes);
  assert.equal(groups.length, 2, '按路径去重为两个文件');
  const a = groups.find((g) => g.path === '/a.js');
  assert.equal(a.first.oldText, '', '首条 oldText 为空（create）');
  assert.equal(a.last.newText, 'AB', '末条 newText 为累计结果');
  assert.equal(a.items.length, 2, '保留该文件全部两次变更历史');
  const b = groups.find((g) => g.path === '/b.js');
  assert.equal(b.items.length, 1);
  assert.equal(b.first.oldText, 'x');
  assert.equal(b.last.newText, 'y');
});

// ---------------------------------------------------------------------------
// 4) diff 记录：fileChanges 投影（host）折叠 tool/result meta.diffs
// ---------------------------------------------------------------------------
const importHost = () => import(pathToFileURL(HOST_INDEX).href);

function fakeHostCtx() {
  let def = null;
  const applyCtx = {
    sessionProjections: { register: (d) => { def = d; } },
    webServer: { register: () => () => {} },
  };
  return { applyCtx, getDef: () => def };
}

function mkEvent(seq, time, diffs) {
  return { type: 'tool/result', seq, time, data: { meta: { diffs } } };
}

test('fileChanges 投影: meta.diffs → 记录 before→after 历史 + op 分类正确', async () => {
  const host = await importHost();
  const { applyCtx, getDef } = fakeHostCtx();
  const dispose = host.apply(applyCtx);
  const def = getDef();
  assert.ok(def, '投影定义应已注册');
  assert.deepEqual(def.init(), { changes: [], truncated: false });

  const s1 = def.apply(def.init(), mkEvent(10, 1000, [
    { path: '/create.js', oldText: '', newText: 'hi\n' },
    { path: '/edit.js', oldText: 'a\nb', newText: 'a\nB' },
    { path: '/delete.js', oldText: 'gone', newText: '' },
  ]));

  assert.equal(s1.changes.length, 3, '三笔 meta.diffs 各落一条记录');
  assert.equal(s1.changes[0].op, 'create');
  assert.equal(s1.changes[1].op, 'edit');
  assert.equal(s1.changes[2].op, 'delete');
  assert.equal(s1.changes[0].seq, 10);
  assert.equal(s1.changes[0].time, 1000);

  // 改动前后对比正确（before→after 全文保留）
  assert.equal(s1.changes[0].oldText, '');
  assert.equal(s1.changes[0].newText, 'hi\n');
  assert.equal(s1.changes[1].oldText, 'a\nb');
  assert.equal(s1.changes[1].newText, 'a\nB');
  assert.equal(s1.changes[2].oldText, 'gone');
  assert.equal(s1.changes[2].newText, '');

  dispose();
});

test('fileChanges 投影: 非 tool/result 或无 diffs → 不产生记录（原 state 引用返回）', async () => {
  const host = await importHost();
  const { applyCtx, getDef } = fakeHostCtx();
  const dispose = host.apply(applyCtx);
  const def = getDef();

  const base = def.apply(def.init(), mkEvent(1, 1, [{ path: '/a', oldText: 'x', newText: 'y' }]));
  assert.equal(base.changes.length, 1);

  assert.equal(def.apply(base, { type: 'message', seq: 2, time: 2, data: {} }), base, '非 tool/result 忽略');
  assert.equal(def.apply(base, mkEvent(3, 3, null)), base, '无 diffs 忽略');
  assert.equal(def.apply(base, mkEvent(4, 4, [])), base, '空 diffs 忽略');

  // 路径缺失 / 非法 diffs 元素被跳过，不影响已有 state
  const s2 = def.apply(base, mkEvent(5, 5, [{ path: '  ', oldText: 'a', newText: 'b' }]));
  assert.equal(s2, base, '空白路径跳过');

  // wire.view 恒等（客户端可见即为持久化 state）
  assert.equal(def.wire.view(base), base);

  dispose();
});

test('fileChanges 投影: 追加多次变更按 seq 顺序累计', async () => {
  const host = await importHost();
  const { applyCtx, getDef } = fakeHostCtx();
  const dispose = host.apply(applyCtx);
  const def = getDef();

  const s1 = def.apply(def.init(), mkEvent(1, 100, [{ path: '/a', oldText: '', newText: 'one' }]));
  const s2 = def.apply(s1, mkEvent(2, 200, [{ path: '/a', oldText: 'one', newText: 'one\ntwo' }]));
  assert.equal(s2.changes.length, 2, '同一文件两次改动各留一条历史');
  assert.equal(s2.changes[0].oldText, '');
  assert.equal(s2.changes[0].newText, 'one');
  assert.equal(s2.changes[1].oldText, 'one');
  assert.equal(s2.changes[1].newText, 'one\ntwo');
  assert.deepEqual(s2.changes.map((c) => c.seq), [1, 2], '按 seq 顺序累计');

  dispose();
});
