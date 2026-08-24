'use strict';

// unit-load-all-history.test.js — K24「一键加载全部历史」单测。
//
// 补丁分两层：
//   1) 内核 dsh-client-runtime/lib/client.js（transformLoadAllHistory）：
//      给 Session 加 loadAllHistory()：按 400 条/批循环 history({beforeSeq,
//      maxMessages}) 拉取，每批 prepend 后 await 让出一帧并更新 loadAllLoaded
//      进度，10000 条保护上限，再点/新会话可 cancelLoadAllHistory() 中断；
//      复用 loadOlder 的去重 + baseSeq + hasMore + trim 抑制语义。
//   2) UI dsh-client-ui-conversation/lib/client.js（transformLoadAllHistoryUi）：
//      ConversationController.loadAllHistory/cancelLoadAllHistory + ChatView
//      「加载全部历史」按钮 + 进度/停止/达上限提示（只追加，不动 K22 自动滚底）。
//
// 本单测经 vm 装载「session-event-bound(K8) + load-all-history(K24)」双层补丁后的
// 内核 client.js，直接实例化内部 Session，验证分批循环、prepend、hasMore 终止、
// 进度、保护上限、取消，以及 K8 loadOlder/trim 不回归；UI 侧做 transform 内容
// 契约 + 幂等 + 语法校验。
//
// 运行：node --test scripts/test/unit-load-all-history.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const {
  transformSessionEventBound,
  transformLoadAllHistory,
  transformLoadAllHistoryUi,
} = require('../lib/patch-adapters');

const DESKTOP_REQ = createRequire(path.join(__dirname, '..', '..', 'package.json'));

/** 定位内核源：优先 pristine rc2 stage，回退真实 node_modules。 */
function resolveSource(pkgRel) {
  const candidates = [
    path.join(__dirname, '..', '..', '..', '.tmp-rc2-stage', 'node_modules', '@deepseek-ai', pkgRel),
    path.join(__dirname, '..', '..', 'node_modules', '@deepseek-ai', pkgRel),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const RUNTIME_PATH = resolveSource(path.join('dsh-client-runtime', 'lib', 'client.js'));
const UI_PATH = resolveSource(path.join('dsh-client-ui-conversation', 'lib', 'client.js'));
const hasSource = RUNTIME_PATH !== null;
const hasUiSource = UI_PATH !== null;

const LIMIT = 10000;
const BATCH = 400;

/** vm 装载 client.js，注入 __Session / __SessionManager 导出。 */
function loadClientModule(src) {
  const injected = src.replace(
    'exports.WorkspaceRuntime = WorkspaceRuntime;',
    'exports.WorkspaceRuntime = WorkspaceRuntime;\n\t\texports.__Session = Session;\n\t\texports.__SessionManager = SessionManager;',
  );
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { captured = def; } } },
    console,
    queueMicrotask: (f) => f(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(injected, sandbox, { filename: 'client.js' });
  assert.ok(captured, 'window.__ModuleLoader__.load 应登记模块');
  const factory = captured.factory;
  const requireShim = (spec) => {
    if (spec === '@deepseek-ai/dsh-client-ui-slots') return {};
    return DESKTOP_REQ(spec);
  };
  return factory(requireShim);
}

/** 双层补丁（模拟生产顺序：session-event-bound order 45 → load-all-history order 46）。 */
function patchedRuntimeSource(pristine) {
  const k8 = transformSessionEventBound(pristine, 'client.js').src;
  const k24 = transformLoadAllHistory(k8, 'client.js');
  assert.equal(k24.status, 'changed', 'load-all-history 应对 K8 补丁后的源 changed');
  return k24.src;
}

/** 造一个可 page 的 history mock：事件 seq 升序 1..totalEvents，按 beforeSeq/maxMessages 切片。 */
function historyPager(totalEvents) {
  return async ({ beforeSeq, maxMessages }) => {
    const start = Math.max(1, beforeSeq - maxMessages);
    const events = [];
    for (let seq = start; seq < beforeSeq; seq += 1) {
      events.push({ event: { seq, type: 'assistant/message', data: { turn: 0 } }, view: undefined });
    }
    return { result: { ok: true, value: { events, hasMore: start > 1 } } };
  };
}

/** 造一个已 open 且装了尾部窗口、hasMore 的 Session。 */
function makePagedSession(mod, totalEvents, windowHeadSeq) {
  const s = new mod.__Session('s1', { sessions: { history: historyPager(totalEvents) } }, {}, {});
  s.openState = 'open';
  s.installWindow([
    { event: { seq: windowHeadSeq, type: 'turn/start', data: { turn: 1 } }, view: undefined },
    { event: { seq: windowHeadSeq + 1, type: 'assistant/message', data: { turn: 1 } }, view: undefined },
  ], true, undefined);
  s.hasMore = true;
  return s;
}

// ---------------------------------------------------------------------------
// 运行时 transform 内容契约 + 幂等。
// ---------------------------------------------------------------------------

test('K24 运行时补丁：注入 loadAllHistory/cancelLoadAllHistory + snapshot 字段（内容契约 + 幂等）', () => {
  assert.ok(hasSource, '缺内核 client.js 源（.tmp-rc2-stage 或 node_modules）');
  const pristine = fs.readFileSync(RUNTIME_PATH, 'utf8');
  const r = transformLoadAllHistory(pristine, 'client.js');
  assert.equal(r.status, 'changed', '未打补丁源应 changed');
  const src = r.src;
  assert.ok(src.includes('dsh-desktop compat: load-all-history'), '应含 marker');
  assert.ok(src.includes('async loadAllHistory() {'), '应注入 loadAllHistory');
  assert.ok(src.includes('cancelLoadAllHistory() {'), '应注入 cancelLoadAllHistory');
  assert.ok(src.includes('maxMessages: BATCH'), '应按批拉取（maxMessages: BATCH）');
  assert.ok(src.includes('const LIMIT = 10000;'), '应含保护上限 LIMIT');
  assert.ok(src.includes('this.loadAllLoaded += freshOlder.length;'), '应累计进度 loadAllLoaded');
  assert.ok(src.includes('this.loadAllLimitReached = true;'), '达上限应置 loadAllLimitReached');
  assert.ok(src.includes('loadingAllHistory: this.loadingAllHistory,'), 'snapshot 应暴露 loadingAllHistory');
  assert.ok(src.includes('loadAllLoaded: this.loadAllLoaded,'), 'snapshot 应暴露 loadAllLoaded');
  assert.ok(src.includes('loadAllLimitReached: this.loadAllLimitReached,'), 'snapshot 应暴露 loadAllLimitReached');
  // 让帧：批间 requestAnimationFrame / setTimeout(0)。
  assert.ok(src.includes('requestAnimationFrame(resolve)') || src.includes('setTimeout(resolve, 0)'), '批间应让帧');
  // 幂等。
  assert.equal(transformLoadAllHistory(src, 'client.js').status, 'already');
  // 不破坏 K8 loadOlder 锚点（loadOlder 仍存在）。
  assert.ok(src.includes('async loadOlder() {'), 'loadOlder 应保留');
});

// ---------------------------------------------------------------------------
// 运行时行为：分批循环 + prepend + hasMore 终止 + 进度。
// ---------------------------------------------------------------------------

test('K24 行为：分批循环拉满、全部 prepend、hasMore 终止、进度累计', { skip: !hasSource }, async () => {
  const pristine = fs.readFileSync(RUNTIME_PATH, 'utf8');
  const mod = loadClientModule(patchedRuntimeSource(pristine));
  const s = makePagedSession(mod, 999, 1000);

  await s.loadAllHistory();

  assert.equal(s.events.length, 1001, '999 条历史 + 2 条尾部窗口 = 1001');
  assert.equal(s.baseSeq, 1, '拉满后 baseSeq 应到 1（最早事件）');
  assert.equal(s.hasMore, false, 'hasMore 应终止为 false');
  assert.equal(s.loadAllLoaded, 999, '进度 loadAllLoaded 应 = 999');
  assert.equal(s.loadingAllHistory, false, '结束后 loadingAllHistory 应复位');
  assert.equal(s.loadingOlder, false, '结束后 loadingOlder 应复位（不锁死 loadOlder）');
  assert.equal(s.loadAllLimitReached, false, '未触上限不置 limitReached');
  // 窗口连续无重复（复用 loadOlder 去重语义）。[...] 展开把 vm 域的数组归一为
  // 宿主域数组，避免 deepStrictEqual 的跨 realm 原型判等误报。
  const seqs = [...s.events.map((e) => e.seq)];
  assert.deepEqual(seqs, Array.from({ length: 1001 }, (_, i) => i + 1), '窗口应从 1..1001 连续无重复');
});

// ---------------------------------------------------------------------------
// 保护上限：超大会话在 10000 条处停止并提示。
// ---------------------------------------------------------------------------

test('K24 行为：超大会话在保护上限 10000 条处停止并置 limitReached', { skip: !hasSource }, async () => {
  const pristine = fs.readFileSync(RUNTIME_PATH, 'utf8');
  const mod = loadClientModule(patchedRuntimeSource(pristine));
  const s = makePagedSession(mod, 30000, 30001);

  await s.loadAllHistory();

  assert.equal(s.loadAllLoaded, LIMIT, `保护上限应为 ${LIMIT} 条`);
  assert.equal(s.loadAllLimitReached, true, '触上限应置 loadAllLimitReached');
  assert.equal(s.hasMore, true, '还有更早历史（hasMore 保持 true）');
  assert.equal(s.loadingAllHistory, false, '结束后 loadingAllHistory 应复位');
  // 窗口长度应封顶在 LIMIT + 尾部 2 条，不无限增长（OOM 保护）。
  assert.ok(s.events.length <= LIMIT + 2, `窗口长度应 <= ${LIMIT + 2}，实际 ${s.events.length}`);
});

// ---------------------------------------------------------------------------
// 取消：加载中 cancelLoadAllHistory 中断（token 失效）。
// ---------------------------------------------------------------------------

test('K24 行为：cancelLoadAllHistory 中断分批加载（不拉满、状态复位）', { skip: !hasSource }, async () => {
  const pristine = fs.readFileSync(RUNTIME_PATH, 'utf8');
  const mod = loadClientModule(patchedRuntimeSource(pristine));
  const s = makePagedSession(mod, 30000, 30001);

  const pending = s.loadAllHistory();
  s.cancelLoadAllHistory();
  await pending;

  assert.equal(s.loadingAllHistory, false, '取消后 loadingAllHistory 应复位');
  assert.equal(s.loadAllCancelled, true, '应标记 loadAllCancelled');
  assert.ok(s.loadAllLoaded < LIMIT, `取消后不应拉满（loadAllLoaded=${s.loadAllLoaded} < ${LIMIT}）`);
  assert.equal(s.loadAllLimitReached, false, '取消不应误报达上限');
});

// ---------------------------------------------------------------------------
// 回归：K8 loadOlder / trim 不被 K24 破坏。
// ---------------------------------------------------------------------------

test('K24 回归：loadOlder 去重 + baseSeq + trim 抑制仍正常（K8 v4 语义不回归）', { skip: !hasSource }, async () => {
  const pristine = fs.readFileSync(RUNTIME_PATH, 'utf8');
  const mod = loadClientModule(patchedRuntimeSource(pristine));

  let calls = 0;
  const s = new mod.__Session('s1', {
    sessions: {
      history: async () => {
        calls += 1;
        if (calls === 1) {
          return { result: { ok: true, value: { events: [
            { event: { seq: 9, type: 'turn/start', data: { turn: 0 } }, view: undefined },
          ], hasMore: false } } };
        }
        return { result: { ok: true, value: { events: [], hasMore: false } } };
      },
    },
  }, {}, {});

  s.openState = 'open';
  s.installWindow([
    { event: { seq: 10, type: 'turn/start', data: { turn: 1 } }, view: undefined },
    { event: { seq: 11, type: 'assistant/message', data: { turn: 1 } }, view: undefined },
  ], false, undefined);
  s.hasMore = true;
  assert.equal(s.baseSeq, 10, '初始 baseSeq 应为 10');

  await s.loadOlder();
  assert.deepEqual([...s.events.map((e) => e.seq)], [9, 10, 11], 'loadOlder 后窗口连续无重复、不回退');
  assert.equal(s.baseSeq, 9, 'baseSeq 应前移到 9');
  assert.equal(s.trimSuppressed, true, 'loadOlder 成功后应抑制重裁');
  assert.equal(s.trimSuppressedFloor, 3, 'trimSuppressedFloor 应记录当前窗口长度');
});

// ---------------------------------------------------------------------------
// UI transform 内容契约 + 幂等 + 语法校验（只追加、不覆盖 K22）。
// ---------------------------------------------------------------------------

test('K24 UI 补丁：注入按钮/控制器/文案（内容契约 + 幂等 + 可解析）', { skip: !hasUiSource }, () => {
  const pristine = fs.readFileSync(UI_PATH, 'utf8');
  const r = transformLoadAllHistoryUi(pristine, 'client.js');
  assert.equal(r.status, 'changed', '未打补丁源应 changed');
  const src = r.src;
  assert.ok(src.includes('dsh-desktop compat: load-all-history button'), '应含 marker');
  assert.ok(src.includes('async loadAllHistory() {'), '控制器应注入 loadAllHistory');
  assert.ok(src.includes('async cancelLoadAllHistory() {'), '控制器应注入 cancelLoadAllHistory');
  assert.ok(src.includes('loadAllHistoryAnchored'), '应注入 loadAllHistoryAnchored');
  assert.ok(src.includes('const loadingAllHistory = useSession((s) => s.loadingAllHistory);'), '应读 loadingAllHistory 状态');
  assert.ok(src.includes('const loadAllLoaded = useSession((s) => s.loadAllLoaded);'), '应读 loadAllLoaded 状态');
  assert.ok(src.includes('"chat.loadAllHistory"'), '应注入 chat.loadAllHistory 文案');
  assert.ok(src.includes('"chat.loadAllProgress"'), '应注入 chat.loadAllProgress 文案');
  assert.ok(src.includes('"chat.loadAllCancel"'), '应注入 chat.loadAllCancel 文案');
  assert.ok(src.includes('"chat.loadAllLimit"'), '应注入 chat.loadAllLimit 文案');
  assert.ok(src.includes('loadAllHistory: () => {'), 'inject 应接入 loadAllHistory');
  assert.ok(src.includes('cancelLoadAllHistory: () => {'), 'inject 应接入 cancelLoadAllHistory');
  // 只追加：既有 loadOlder / 回到底部 / 自动滚底逻辑必须原样保留。
  assert.ok(src.includes('async loadOlder() {'), 'loadOlder 控制器应保留');
  assert.ok(src.includes('const loadOlderAnchored = () => {'), 'loadOlderAnchored 应保留');
  assert.ok(src.includes('"chat.loadOlder"'), 'chat.loadOlder 文案应保留');
  assert.ok(src.includes('"chat.toBottom"'), 'chat.toBottom 文案应保留');
  // 语法可解析（JSX 编译产物是纯 JS）。
  assert.doesNotThrow(() => new vm.Script(src, { filename: 'client.js' }), '补丁后 UI 源应可解析');
  // 幂等。
  assert.equal(transformLoadAllHistoryUi(src, 'client.js').status, 'already');
});

// ---------------------------------------------------------------------------
// 运行时 + UI 组合：双层补丁后仍可解析（K8 + K24 顺序无冲突）。
// ---------------------------------------------------------------------------

test('K24 组合：K8 + K24 运行时 + UI 双层补丁后均语法可解析', { skip: !hasSource || !hasUiSource }, () => {
  const rtPristine = fs.readFileSync(RUNTIME_PATH, 'utf8');
  const rt = patchedRuntimeSource(rtPristine);
  assert.doesNotThrow(() => new vm.Script(rt, { filename: 'client.js' }), '双层运行时补丁应可解析');

  const uiPristine = fs.readFileSync(UI_PATH, 'utf8');
  const ui = transformLoadAllHistoryUi(uiPristine, 'client.js').src;
  assert.doesNotThrow(() => new vm.Script(ui, { filename: 'client.js' }), 'UI 补丁应可解析');
});
