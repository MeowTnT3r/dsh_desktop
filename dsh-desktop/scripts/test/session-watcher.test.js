'use strict';
// session-watcher.js 单测（C1 迁移配套，2026-08）：结束识别质量的最小用例集。
// 直接 require 模块（vm 级）+ 手动调 process()/scan()（确定性，不依赖清扫
// 定时器）。zstd fixture 用 vendor node 的 zlib.zstdCompressSync 构造——
// 与被测代码 zstdDecompressSync 互逆，同一条编解码路径。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { SessionWatcher, scanZstdFrames } = require('../../session-watcher.js');

function tmpSessionsDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-swatch-' + tag + '-'));
}

// 一批 JSONL 行压成一个 zstd 帧（磁盘格式：帧 = JSONL 记录块）。
function frameOf(rows) {
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

// 建一个会话文件并返回 { file, append(rows), appendRaw(buf) }。
function makeSession(dir, rel, headerRows) {
  const file = path.join(dir, rel, 'session.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, frameOf(headerRows));
  return {
    file,
    append(rows) { fs.appendFileSync(file, frameOf(rows)); },
    appendRaw(buf) { fs.appendFileSync(file, buf); },
  };
}

function makeWatcher(dir, events) {
  return new SessionWatcher({
    sessionsDir: dir,
    onTurnEnd: (info) => events.push(info),
    log: () => {},
    statSweepMs: 60_000,
    walkSweepMs: 60_000,
  });
}

const SID = 'sess-aaaa-bbbb-cccc';

function header(extra) {
  return Object.assign({ type: 'session', id: SID, cwd: 'C:\\work\\demo' }, extra || {});
}

test('基线不重放：启动前已完成的历史 turn 不通知', () => {
  const dir = tmpSessionsDir('baseline');
  const s = makeSession(dir, '2026/08/' + SID, [
    header(),
    { type: 'turn/start' },
    { type: 'turn/end' },
    { type: 'turn/start' },
    { type: 'turn/end' },
  ]);
  const events = [];
  const w = makeWatcher(dir, events);
  w.process(s.file); // 基线：只解析头部，纯连续历史零通知
  assert.strictEqual(events.length, 0, '存量会话历史不得刷屏');
  w.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('running→done：基线后追加 turn/end 恰好通知一次，文案同 Electron emit', () => {
  const dir = tmpSessionsDir('run-done');
  const s = makeSession(dir, SID, [header(), { type: 'turn/start' }]);
  const events = [];
  const w = makeWatcher(dir, events);
  w.process(s.file); // 基线（turn/start 已在历史里 → hasTurnEvents 置位）
  assert.strictEqual(events.length, 0);

  s.append([{ type: 'session/title', data: { title: '修复登录' } }, { type: 'turn/end' }]);
  w.process(s.file);
  assert.strictEqual(events.length, 1, 'turn/end 恰好一次');
  const ev = events[0];
  assert.strictEqual(ev.sessionId, SID);
  assert.strictEqual(ev.title, '修复登录', 'session/title 事件覆盖默认标题');
  assert.strictEqual(ev.body, 'demo · 会话 ' + SID.slice(-8), '正文 = cwd 尾段 · 会话 尾8');
  w.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('turn/start 触发 onTurnStart；真实 turn/end 带 turnBased=true + count', () => {
  const dir = tmpSessionsDir('turn-start');
  const s = makeSession(dir, SID, [header()]);
  const starts = [];
  const ends = [];
  const w = new SessionWatcher({
    sessionsDir: dir,
    onTurnStart: (info) => starts.push(info),
    onTurnEnd: (info) => ends.push(info),
    log: () => {},
    statSweepMs: 60_000,
    walkSweepMs: 60_000,
  });
  w.process(s.file); // 基线（无 turn 事件 → 零通知）
  s.append([{ type: 'turn/start' }, { type: 'turn/end' }]);
  w.process(s.file);
  assert.strictEqual(starts.length, 1, 'turn/start 恰好触发一次 onTurnStart');
  assert.strictEqual(starts[0].sessionId, SID);
  assert.strictEqual(starts[0].count, 1);
  assert.strictEqual(ends.length, 1, 'turn/end 恰好触发一次 onTurnEnd');
  assert.strictEqual(ends[0].turnBased, true, '真实 turn/end 标记 turnBased=true');
  assert.strictEqual(ends[0].count, 1);
  w.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('assistant/message 兜底 turn-end 不带 turnBased（不误消进行中回合）', () => {
  const dir = tmpSessionsDir('fallback-flag');
  const s = makeSession(dir, SID, [header()]);
  const ends = [];
  const w = new SessionWatcher({
    sessionsDir: dir,
    onTurnEnd: (info) => ends.push(info),
    log: () => {},
    statSweepMs: 60_000,
    walkSweepMs: 60_000,
  });
  w.process(s.file); // 基线
  s.append([{ type: 'assistant/message' }]);
  w.process(s.file);
  assert.strictEqual(ends.length, 1, '兜底通知触发');
  assert.strictEqual(ends[0].turnBased, false, '兜底通知 turnBased=false');
  w.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('running（turn/start 无 end）不判完；撕裂帧不误报且能恢复后续帧', () => {
  const dir = tmpSessionsDir('interrupt');
  const s = makeSession(dir, SID, [header(), { type: 'turn/start' }]);
  const events = [];
  const w = makeWatcher(dir, events);
  w.process(s.file);
  // 手造「写了一半的大块帧」：magic + 描述符 + 窗口字节 + 块头（声明
  // 128KB 载荷，实际只剩 0 字节）——大块写中途被切断的真实形态。
  // 结构扫描必须判 torn：不误报，且不吞掉后面追加的完整帧。
  const magic = Buffer.alloc(4);
  magic.writeUInt32LE(4247762216, 0);
  const torn = Buffer.concat([
    magic,                       // zstd magic（28 B5 2F FD）
    Buffer.from([0x00]),         // 帧描述符：无校验和/无字典/非单段
    Buffer.from([0x00]),         // 窗口描述符
    Buffer.from([0x04, 0x00, 0x10]), // 块头：lastBlock=0 type=compressed size=0x20000
  ]);
  s.appendRaw(torn);
  w.process(s.file);
  assert.strictEqual(events.length, 0, '撕裂帧（无完整 turn/end）不得通知');
  // 撕裂帧之后追加的完整帧必须被恢复识别（torn → 向后找下一个 magic）。
  s.append([{ type: 'turn/end' }]);
  w.process(s.file);
  assert.strictEqual(events.length, 1, '撕裂区后的完整帧应恢复识别');
  w.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('多会话独立：互不串扰、各自通知', () => {
  const dir = tmpSessionsDir('multi');
  const s1 = makeSession(dir, 'sess-1111-1111', [header({ id: 'sess-1111-1111' }), { type: 'turn/start' }]);
  const s2 = makeSession(dir, 'sess-2222-2222', [header({ id: 'sess-2222-2222' }), { type: 'turn/start' }]);
  const events = [];
  const w = makeWatcher(dir, events);
  w.scan(); // 目录级基线（递归发现两个会话）
  s1.append([{ type: 'turn/end' }]);
  s2.append([{ type: 'turn/end' }, { type: 'turn/end' }]);
  w.scan();
  assert.strictEqual(events.length, 2);
  const ids = events.map((e) => e.sessionId).sort();
  assert.deepStrictEqual(ids, ['sess-1111-1111', 'sess-2222-2222']);
  // s2 一次两轮 → 文案带轮数后缀。
  const s2ev = events.find((e) => e.sessionId === 'sess-2222-2222');
  assert.ok(s2ev.body.includes('（2 轮任务完成）'), '多轮后缀: ' + s2ev.body);
  w.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('subagent（delegationDepth>0）不通知', () => {
  const dir = tmpSessionsDir('subagent');
  const s = makeSession(dir, 'sub-9999', [
    header({ id: 'sub-9999', delegationDepth: 1 }),
    { type: 'turn/start' },
  ]);
  const events = [];
  const w = makeWatcher(dir, events);
  w.process(s.file);
  s.append([{ type: 'turn/end' }]);
  w.process(s.file);
  assert.strictEqual(events.length, 0, 'subagent 日志是通知噪声，必须跳过');
  w.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('无 turn 事件的旧会话按 assistant/message 兜底计数', () => {
  const dir = tmpSessionsDir('fallback');
  const s = makeSession(dir, SID, [header()]);
  const events = [];
  const w = makeWatcher(dir, events);
  w.process(s.file); // 基线（无 turn 事件 → hasTurnEvents=false）
  s.append([{ type: 'assistant/message' }]);
  w.process(s.file);
  assert.strictEqual(events.length, 1, 'assistant/message 兜底触发');
  assert.strictEqual(events[0].sessionId, SID);
  w.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI 守卫：作为模块被 require 时不进入 CLI 分支', () => {
  // 上方各用例已直接依赖「require 后无副作用」（没有 process.exit/占住
  // stdio）——本用例固化该契约的可见面：模块导出不受 CLI 块影响。
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'session-watcher.js'), 'utf8');
  assert.ok(src.includes("require.main === module"), 'CLI 分支必须有 require.main 守卫');
  assert.ok(src.includes("'turn-end'"), '行协议 type 标记存在');
});
