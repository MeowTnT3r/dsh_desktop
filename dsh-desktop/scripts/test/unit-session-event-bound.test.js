'use strict';

// unit-session-event-bound.test.js — v0.5.4 多子代理渲染进程 OOM 根治补丁单测。
//
// 补丁（patch-adapters.transformSessionEventBound）对内核 dsh-client-runtime
// lib/client.js 做两件事：
//   1) Session.appendLive 追加后调用 trimSessionWindow()：events 超
//      SESSION_EVENT_BOUND（2000）时按 turn/start 对齐裁掉最旧切片并 flip
//      hasMore（host 会话日志是持久真相，loadOlder 可按需回翻）；
//   2) Session.dispose() 实装 + SessionManager.drop() 调用：会话被 prune/drop
//      时清空 events/views/conversation 派生态，解决「切会话/删会话后仍常驻」。
//
// 本单测通过 vm 装载补丁前（pristine）与补丁后（patched）两份内核 client.js，
// 直接实例化内部 Session（测试期注入 __Session 导出），验证：
//   1) 有界保留后 events 长度有上界（且视图数组同步、turn 对齐、hasMore flip）；
//   2) dispose 释放（events/views/liveBuffer/pending 清空、幂等）；
//   3) SessionManager.drop 触发 dispose；
//   4) trim 复用 replaceWindow（open/resync 同款），重建后继续 append 不抛、
//      结构性事件（turn 边界 / 消息 / compaction 摘要）在尾部窗口内保持连续；
//   5) 多 Session 高频 appendLive 压测：每个 Session events 长度有上界，
//      补丁前后内存斜率对比（pristine 线性增长 vs patched 封顶）。
//
// 运行：node --test scripts/test/unit-session-event-bound.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const { transformSessionEventBound } = require('../lib/patch-adapters');

const BOUND = 2000;
const KEEP = 1200;
const RUNNING_HARD_CAP = 6000;

/** 定位内核 client.js 源：优先 pristine rc2 stage，回退真实 node_modules（当前未打补丁树）。 */
function resolveClientSource() {
  const candidates = [
    path.join(__dirname, '..', '..', '..', '.tmp-rc2-stage', 'node_modules', '@deepseek-ai', 'dsh-client-runtime', 'lib', 'client.js'),
    path.join(__dirname, '..', '..', 'node_modules', '@deepseek-ai', 'dsh-client-runtime', 'lib', 'client.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const CLIENT_PATH = resolveClientSource();
const DESKTOP_REQ = createRequire(path.join(__dirname, '..', '..', 'package.json'));

/**
 * vm 装载 client.js（window.__ModuleLoader__.load 形态），返回模块 exports。
 * 测试期注入 __Session / __SessionManager 导出（仅观测用，非生产面）。
 */
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
    // dsh-client-ui-slots 在本测试环境不装配：返回空对象即可（仅 slots 子系统懒用）。
    if (spec === '@deepseek-ai/dsh-client-ui-slots') return {};
    return DESKTOP_REQ(spec);
  };
  return factory(requireShim);
}

/** 造一个可 appendLive 的最小 Session（openState 无需真实 open）。 */
function makeSession(mod, sessionId = 's1') {
  const api = { sessions: { history: async () => ({ result: { ok: true, value: { events: [], hasMore: false } } }) } };
  return new mod.__Session(sessionId, api, {}, {});
}

/** 事件工厂：seq 从 1 递增；每 turnSize 条一个 turn/start，末尾一个 compaction/summary。 */
function eventAt(seq, turnSize) {
  if (seq % turnSize === 0) return { seq, type: 'turn/start', data: { turn: Math.floor(seq / turnSize) } };
  if (seq % turnSize === 5) return { seq, type: 'compaction/summary', data: { summary: [{ type: 'text', text: 's' + seq }] } };
  if (seq % turnSize === 8) return { seq, type: 'user/message', data: { id: 'm' + seq } };
  return { seq, type: 'assistant/message', data: { turn: Math.floor(seq / turnSize) } };
}

const hasSource = CLIENT_PATH !== null;

test('补丁 transform 注入有界保留 + dispose + drop（内容契约）', () => {
  assert.ok(hasSource, '缺内核 client.js 源（.tmp-rc2-stage 或 node_modules）');
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const r = transformSessionEventBound(pristine, 'client.js');
  assert.equal(r.status, 'changed', '未打补丁源应 changed');
  const src = r.src;
  assert.ok(src.includes('dsh-desktop compat: bounded session event retention'), '应含 marker');
  assert.ok(src.includes('const SESSION_EVENT_BOUND = 2000;'), '应含 SESSION_EVENT_BOUND');
  assert.ok(src.includes('const SESSION_EVENT_KEEP = 1200;'), '应含 SESSION_EVENT_KEEP');
  assert.ok(src.includes('const SESSION_EVENT_SUPPRESS_MARGIN = 20000;'), '应含 v4 SESSION_EVENT_SUPPRESS_MARGIN');
  assert.ok(src.includes('trimSessionWindow() {'), '应注入 trimSessionWindow 方法');
  assert.ok(src.includes('this.trimSessionWindow();'), 'appendLive 应调用 trimSessionWindow');
  assert.ok(src.includes('if (this.loadingOlder) return;'), 'v4：loadOlder 期间 trim 应直接 return');
  assert.ok(src.includes('if (this.trimSuppressed === true) {'), 'v4：应含 trimSuppressed 抑制分支');
  assert.ok(src.includes('const freshOlder = older.filter'), 'v4：loadOlder 应含去重');
  assert.ok(src.includes('this.trimSuppressedFloor = this.events.length;'), 'v4：loadOlder 成功应记录 floor');
  assert.ok(src.includes('this.conversation.replaceWindow([], false);'), 'dispose 应重建空窗口');
  assert.ok(src.includes('if (session !== void 0) session.dispose();'), 'drop 应调用 dispose');
  assert.ok(src.includes('if (this.disposed === true) return;'), 'dispose 应幂等');
  // 幂等：二次 transform already。
  assert.equal(transformSessionEventBound(src, 'client.js').status, 'already');
});

test('有界保留：events 长度有上界、views 同步、turn 对齐、hasMore flip', { skip: !hasSource }, () => {
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const patched = transformSessionEventBound(pristine, 'client.js').src;
  const mod = loadClientModule(patched);
  const s = makeSession(mod);

  const TOTAL = 5000;
  for (let i = 1; i <= TOTAL; i += 1) s.appendLive(eventAt(i, 50), undefined);

  assert.ok(s.events.length <= BOUND, `events 应有上界 ${BOUND}，实际 ${s.events.length}`);
  // trim 在 events 超 BOUND 时回落到 ~KEEP，随后继续追加直至再次触顶，故最终
  // 长度在 (KEEP, BOUND] 区间内；硬上界恒为 BOUND。
  assert.ok(s.events.length > KEEP, `压测后长度应高于 KEEP(${KEEP})（末次 trim 后继续追加），实际 ${s.events.length}`);
  assert.equal(s.views.length, s.events.length, 'views 与 events 同步裁剪');
  assert.equal(s.baseSeq, s.events[0].seq, 'baseSeq 应对齐裁剪后首事件 seq');
  assert.equal(s.hasMore, true, '裁剪后 hasMore 应 flip true（旧切片在 host 可回翻）');
  assert.equal(s.events[0].type, 'turn/start', '裁剪首事件应对齐 turn/start 边界');
  // conversation.inputs 与 events 同步有界（内存双副本一致封顶）。
  assert.ok(s.conversation.inputs.size <= BOUND, `conversation.inputs 应有上界，实际 ${s.conversation.inputs.size}`);
});

test('补丁前（pristine）无界：同一压测 events 线性增长到 5000（对照斜率）', { skip: !hasSource }, () => {
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const mod = loadClientModule(pristine);
  const s = makeSession(mod);

  for (let i = 1; i <= 5000; i += 1) s.appendLive(eventAt(i, 50), undefined);

  assert.equal(s.events.length, 5000, 'pristine 无 trim，events 线性堆积（OOM 根因）');
});

test('dispose 释放：events/views/liveBuffer/pending 清空且幂等', { skip: !hasSource }, () => {
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const patched = transformSessionEventBound(pristine, 'client.js').src;
  const mod = loadClientModule(patched);
  const s = makeSession(mod);

  for (let i = 1; i <= 100; i += 1) s.appendLive(eventAt(i, 50), undefined);
  assert.ok(s.events.length > 0, 'dispose 前应有事件');

  s.dispose();
  assert.equal(s.events.length, 0, 'dispose 后 events 应清空');
  assert.equal(s.views.length, 0, 'dispose 后 views 应清空');
  assert.equal(s.liveBuffer.length, 0, 'dispose 后 liveBuffer 应清空');
  assert.equal(s.pending.size, 0, 'dispose 后 pending 应清空');
  assert.equal(s.disposed, true, 'dispose 应标记 disposed');

  // 幂等：二次 dispose 不抛、状态不变。
  s.dispose();
  assert.equal(s.events.length, 0, '二次 dispose 应保持清空');
});

test('SessionManager.drop 触发 session.dispose（切/删会话后释放常驻）', { skip: !hasSource }, () => {
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const patched = transformSessionEventBound(pristine, 'client.js').src;
  const mod = loadClientModule(patched);

  const api = { sessions: {} };
  const mgr = new mod.__SessionManager(api, {}, undefined, undefined, undefined);
  const s = makeSession(mod, 'dropped');
  s.appendLive({ seq: 1, type: 'user/message', data: { id: 'm1' } }, undefined);
  assert.ok(s.events.length > 0);

  mgr.sessions.set('dropped', s);
  mgr.drop('dropped');
  assert.equal(mgr.sessions.has('dropped'), false, 'drop 后 sessions 摘除');
  assert.equal(s.disposed, true, 'drop 应触发 dispose');
  assert.equal(s.events.length, 0, 'drop 后事件应释放');
});

test('replay 连续性：trim 后 installWindow 重建 + 继续 appendLive 不抛、窗口仍连续', { skip: !hasSource }, () => {
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const patched = transformSessionEventBound(pristine, 'client.js').src;
  const mod = loadClientModule(patched);
  const s = makeSession(mod);

  // 压到触发 trim。
  for (let i = 1; i <= 3000; i += 1) s.appendLive(eventAt(i, 50), undefined);
  assert.ok(s.events.length <= BOUND);

  // 模拟 open/resync/gap-repair 的 replay：installWindow 用新历史窗重建。
  const replayEntries = [
    { event: { seq: 9000, type: 'turn/start', data: { turn: 1 } }, view: undefined },
    { event: { seq: 9001, type: 'assistant/message', data: { turn: 1 } }, view: undefined },
  ];
  assert.doesNotThrow(() => s.installWindow(replayEntries, false, undefined));
  assert.equal(s.events.length, 2, 'replay 重建后 events 即新窗口');
  assert.equal(s.baseSeq, 9000, 'replay 后 baseSeq 即新窗口首 seq');

  // 继续 appendLive：不抛、seq 连续性仍由 windowTailSeq 守卫。
  assert.doesNotThrow(() => s.appendLive({ seq: 9002, type: 'assistant/message', data: { turn: 1 } }, undefined));
  assert.equal(s.events[s.events.length - 1].seq, 9002, '重建后追加仍按 seq 续接');
});

test('多 Session 高频压测：每个 Session events 有上界（内存斜率趋平）', { skip: !hasSource }, () => {
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const patched = transformSessionEventBound(pristine, 'client.js').src;
  const mod = loadClientModule(patched);

  const SESSIONS = 8;
  const EVENTS = 4000;
  const sessions = [];
  for (let n = 0; n < SESSIONS; n += 1) {
    const s = makeSession(mod, 'subagent-' + n);
    for (let i = 1; i <= EVENTS; i += 1) s.appendLive(eventAt(i, 50), undefined);
    sessions.push(s);
  }

  // 每个 Session 独立有界（多子代理 = 多 Session 场景下渲染进程内存不再随
  // 事件数无上限增长）。
  for (const s of sessions) {
    assert.ok(s.events.length <= BOUND, `每 Session events 应有上界，实际 ${s.events.length}`);
    assert.ok(s.conversation.inputs.size <= BOUND, `每 Session conversation.inputs 应有上界`);
  }
  // 结构性事件在尾部窗口内保持（rewind/compaction 依赖的 turn/start 与
  // compaction/summary 不被裁掉到只剩碎片）。
  const tail = sessions[0].events;
  assert.ok(tail.some((e) => e.type === 'turn/start'), '尾部窗口应保留 turn/start 边界');
  assert.ok(tail.some((e) => e.type === 'compaction/summary'), '尾部窗口应保留 compaction/summary 摘要');
});

// ---------------------------------------------------------------------------
// v4 回归：loadOlder / trim 接缝 + 运行中不裁（历史加载回归修复）。
// ---------------------------------------------------------------------------

test('v4：loadOlder 请求期间 trimSessionWindow 直接 return（baseSeq 不动）', { skip: !hasSource }, () => {
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const patched = transformSessionEventBound(pristine, 'client.js').src;
  const mod = loadClientModule(patched);
  const s = makeSession(mod);

  s.loadingOlder = true;
  for (let i = 1; i <= 3000; i += 1) s.appendLive(eventAt(i, 50), undefined);
  assert.equal(s.events.length, 3000, 'loadOlder 期间 appendLive 不应触发 trim');
  assert.equal(s.baseSeq, 0, 'loadOlder 期间 baseSeq 应保持不动（trim 未触发）');

  // 解除 loadingOlder 后再追加 → 恢复 trim。
  s.loadingOlder = false;
  s.appendLive(eventAt(3001, 50), undefined);
  assert.ok(s.events.length <= BOUND, '解除 loadingOlder 后应恢复 trim 有界');
});

test('v4：loadOlder 成功后 trimSuppressed 抑制重裁，超动态上限才重新裁', { skip: !hasSource }, () => {
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const patched = transformSessionEventBound(pristine, 'client.js').src;
  const mod = loadClientModule(patched);
  const s = makeSession(mod);

  for (let i = 1; i <= 100; i += 1) s.appendLive(eventAt(i, 50), undefined);
  s.trimSuppressed = true;
  s.trimSuppressedFloor = s.events.length; // 100

  const MARGIN = 20000;
  for (let i = 0; i < MARGIN; i += 1) s.appendLive(eventAt(101 + i, 50), undefined);
  assert.equal(s.events.length, 100 + MARGIN, 'floor+margin 内不应裁');
  assert.equal(s.trimSuppressed, true, '抑制状态应保持');

  // 再追加 1 条 → 超动态上限 → 重裁并清除抑制。
  s.appendLive(eventAt(101 + MARGIN, 50), undefined);
  assert.ok(s.events.length <= BOUND, '超动态上限后应重裁到有界窗口');
  assert.equal(s.trimSuppressed, false, '重裁后应清除抑制状态');
});

test('v4：loadOlder 回翻连续、不回退、不重复，并记录抑制 floor', { skip: !hasSource }, async () => {
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const patched = transformSessionEventBound(pristine, 'client.js').src;
  const mod = loadClientModule(patched);

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

test('v4：baseSeq 偏移时 loadOlder 去重，防止重复事件进入窗口（duplicate start 根治）', { skip: !hasSource }, async () => {
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const patched = transformSessionEventBound(pristine, 'client.js').src;
  const mod = loadClientModule(patched);

  const s = new mod.__Session('s1', {
    sessions: {
      history: async () => ({ result: { ok: true, value: { events: [
        { event: { seq: 9, type: 'turn/start', data: { turn: 0 } }, view: undefined },
        { event: { seq: 10, type: 'assistant/message', data: { turn: 1 } }, view: undefined },
        { event: { seq: 11, type: 'assistant/message', data: { turn: 1 } }, view: undefined },
      ], hasMore: false } } }),
    },
  }, {}, {});

  s.openState = 'open';
  s.installWindow([
    { event: { seq: 10, type: 'assistant/message', data: { turn: 1 } }, view: undefined },
    { event: { seq: 11, type: 'assistant/message', data: { turn: 1 } }, view: undefined },
  ], false, undefined);
  s.hasMore = true;
  // 人为制造 baseSeq 漂移（模拟 trim 后 baseSeq 与窗口首事件不一致的边界）。
  s.baseSeq = 12;

  await s.loadOlder();
  // 历史回页 [9,10,11] 与现有窗口 [10,11] 重叠：10/11 被去重，仅前插 9。
  assert.deepEqual([...s.events.map((e) => e.seq)], [9, 10, 11], '重叠事件应去重，窗口不出现重复 seq');
  assert.equal(new Set(s.events.map((e) => e.seq)).size, s.events.length, 'events 内 seq 应唯一（后续 trim/replaceWindow 不再 duplicate start）');
});

// ---------------------------------------------------------------------------
// K22 回归：流式期间（running=true）trim 暂缓，避免 replaceWindow 重建把上滚读者
// 拉回底部。仅当超过 SESSION_EVENT_RUNNING_HARD_CAP 的紧急上限才兜底裁；turn 边界
// （running=false）恢复照常裁回 KEEP。
// ---------------------------------------------------------------------------

test('K22：transform 注入 running 门控 + 紧急硬上限（内容契约 + 幂等）', () => {
  assert.ok(hasSource, '缺内核 client.js 源（.tmp-rc2-stage 或 node_modules）');
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const r = transformSessionEventBound(pristine, 'client.js');
  assert.equal(r.status, 'changed', '未打补丁源应 changed');
  const src = r.src;
  assert.ok(src.includes('const SESSION_EVENT_RUNNING_HARD_CAP = 6000;'), '应注入 running 紧急硬上限常量');
  assert.ok(
    src.includes('if (this.running === true && this.events.length <= SESSION_EVENT_RUNNING_HARD_CAP) return;'),
    '应注入 running 门控（流式期间暂缓 trim）',
  );
  // 门控必须位于 trimSessionWindow 内、且在 BOUND 早退之后。
  const trimStart = src.indexOf('trimSessionWindow() {');
  const boundIdx = src.indexOf('if (this.events.length <= SESSION_EVENT_BOUND) return;', trimStart);
  const guardIdx = src.indexOf('if (this.running === true', trimStart);
  assert.ok(boundIdx > trimStart && guardIdx > boundIdx, 'running 门控应位于 trimSessionWindow 内、BOUND 早退之后');
  // 幂等：二次 transform already。
  assert.equal(transformSessionEventBound(src, 'client.js').status, 'already');
});

test('K22：running=true 流式期间 trim 暂缓，超硬上限才紧急裁', { skip: !hasSource }, () => {
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const patched = transformSessionEventBound(pristine, 'client.js').src;
  const mod = loadClientModule(patched);
  const s = makeSession(mod);
  s.handleRunning(true);

  // 超过 BOUND 但低于硬上限：running 期间不裁（用户可安心上滚读历史）。
  for (let i = 1; i <= BOUND + 500; i += 1) s.appendLive(eventAt(i, 50), undefined);
  assert.equal(s.events.length, BOUND + 500, 'running 期间超 BOUND 不应裁');
  assert.equal(s.hasMore, false, '未裁则 hasMore 不 flip');

  // 冲过硬上限：紧急兜底裁一次，hasMore flip。
  for (let i = BOUND + 501; i <= RUNNING_HARD_CAP + 500; i += 1) s.appendLive(eventAt(i, 50), undefined);
  assert.ok(s.events.length < RUNNING_HARD_CAP, `超硬上限后应紧急裁，实际 ${s.events.length}`);
  assert.equal(s.hasMore, true, '紧急裁后 hasMore 应 flip true');
  assert.equal(s.events[0].type, 'turn/start', '紧急裁首事件仍对齐 turn/start 边界');
});

test('K22：running 翻 false 后 trim 恢复（turn 边界照常裁回有界窗口）', { skip: !hasSource }, () => {
  const pristine = fs.readFileSync(CLIENT_PATH, 'utf8');
  const patched = transformSessionEventBound(pristine, 'client.js').src;
  const mod = loadClientModule(patched);
  const s = makeSession(mod);
  s.handleRunning(true);

  // 流式期间累积到超过 BOUND（未达硬上限）→ 不裁。
  for (let i = 1; i <= BOUND + 500; i += 1) s.appendLive(eventAt(i, 50), undefined);
  assert.ok(s.events.length > BOUND, 'running 期间超 BOUND 不裁');

  // turn 结束：running=false，下一次 append 恢复裁到有界窗口。
  s.handleRunning(false);
  s.appendLive(eventAt(BOUND + 501, 50), undefined);
  assert.ok(s.events.length <= BOUND, `running=false 后应恢复 trim，实际 ${s.events.length}`);
  assert.equal(s.hasMore, true, '恢复 trim 后 hasMore 应 flip true');
});
