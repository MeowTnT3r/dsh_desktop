'use strict';
// session-watcher.js CLI 模式（Tauri 壳 C1 行协议）对抗验收测试（N2）：
// 直接 spawn 真实脚本（vendor node 同语义，用测试进程自身 node），验证——
//   · 协议行语法/语义（type/sessionId/title/body 与 Rust 解析器契约一致）
//   · 增量 turn/end → 恰一行（10s 兜底 stat 清扫路径；fs.watch 挂载前）
//   · 多轮聚合（（N 轮任务完成）后缀）
//   · 中段垃圾恢复（基线空隙路径，事件级、无清扫等待）
//   · 撕裂帧尾部：未完成不吐行，补齐后吐行（scanZstdFrames torn 恢复）
//   · delegationDepth>0（subagent）不吐行
//   · 非字符串会话 id → sessionId:null（Electron 仍通知；Rust 侧丢行——
//     漂移已记录在验收报告，本测试固化 JS 侧行为）
//   · stdin 关闭自退（孤儿防护）/ 会话目录缺失不崩溃 / 删除文件竞态不崩溃
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const WATCHER = require.resolve('../../session-watcher');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function header(id, extra) {
  return JSON.stringify(Object.assign(
    { type: 'session', id, cwd: 'C:/fake', created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' },
    extra || {}
  )) + '\n';
}
function frame(records) {
  return zlib.zstdCompressSync(Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8'));
}
function makeSessionFile(file, id, extra) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, frame([JSON.parse(header(id, extra))]));
}
function appendFrame(file, records) {
  fs.appendFileSync(file, frame(records));
}

/** spawn CLI 并收集 stdout 行 / stderr。返回 {child, lines, stderr, waitLine}。 */
function startCli(sessionsDir) {
  const child = spawn(process.execPath, [WATCHER, '--sessions-dir', sessionsDir], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  const stderr = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) lines.push(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => stderr.push(c));
  const waitLine = async (deadlineMs) => {
    const deadline = Date.now() + deadlineMs;
    while (lines.length === 0 && Date.now() < deadline) await sleep(100);
    return lines.length > 0 ? JSON.parse(lines[0]) : null;
  };
  // 等一条指定 type 的协议行（issue #159：CLI 现在也吐 turn-start 行，
  // 通知类断言需跳过它精准等 turn-end）。命中即从 lines 移除。
  const waitType = async (type, deadlineMs) => {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      const i = lines.findIndex((l) => {
        try { return JSON.parse(l).type === type; } catch { return false; }
      });
      if (i >= 0) return JSON.parse(lines.splice(i, 1)[0]);
      await sleep(100);
    }
    return null;
  };
  return { child, lines, stderr, waitLine, waitType };
}

async function stopCli(child) {
  if (child.exitCode !== null) return;
  child.stdin.end();
  const deadline = Date.now() + 5000;
  while (child.exitCode === null && Date.now() < deadline) await sleep(100);
  if (child.exitCode === null) child.kill();
}

/** 协议行契约（与 Rust parse_watcher_line 对齐）：type/sessionId/title/body。 */
function assertProtocolShape(ev) {
  assert.strictEqual(ev.type, 'turn-end', 'type 必须为 turn-end');
  if (ev.sessionId !== null) {
    assert.strictEqual(typeof ev.sessionId, 'string', 'sessionId 为字符串或 null');
    const id = ev.sessionId.trim();
    assert.ok(id.length >= 1 && id.length <= 256, 'sessionId trim 后 1..256');
  }
  for (const k of ['title', 'body']) {
    assert.ok(ev[k] === null || typeof ev[k] === 'string', `${k} 为字符串或 null`);
  }
}

test('cli: mid-file garbage recovered turn/end emits protocol lines (baseline gap path)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swcli-gap-'));
  const file = path.join(tmp, 'p1', 's1', 'session.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, frame([JSON.parse(header('sess-t1-abcdefgh'))]));
  fs.appendFileSync(file, Buffer.from([0xde, 0xad, 0xbe, 0xef])); // 帧间垃圾
  fs.appendFileSync(file, frame([{ type: 'turn/start' }, { type: 'turn/end' }]));
  const cli = startCli(tmp);
  try {
    // issue #159：turn/start 先于 turn/end 吐行（回合进行中信号）。
    const start = await cli.waitType('turn-start', 5000);
    assert.ok(start, '基线空隙路径应事件级吐 turn-start（setImmediate 首扫）');
    assert.strictEqual(start.sessionId, 'sess-t1-abcdefgh');
    assert.strictEqual(start.count, 1);
    const ev = await cli.waitType('turn-end', 5000);
    assert.ok(ev, '基线空隙路径应事件级吐 turn-end');
    assertProtocolShape(ev);
    assert.strictEqual(ev.sessionId, 'sess-t1-abcdefgh');
    assert.strictEqual(ev.title, 'DSH 任务完成', '无 session/title 事件 → 默认标题');
    assert.strictEqual(ev.body, 'fake · 会话 abcdefgh', 'cwd 基名 · 会话 尾8字符');
    assert.strictEqual(ev.count, 1, '真实 turn/end 带 count');
    await sleep(800);
    assert.strictEqual(cli.lines.length, 0, 'turn-start + turn-end 恰两行（已消费）');
  } finally {
    await stopCli(cli.child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('cli: incremental turn/end via stat sweep; multi-turn aggregation suffix', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swcli-inc-'));
  const file = path.join(tmp, 'p1', 's2', 'session.jsonl.zstd');
  makeSessionFile(file, 'sess-t2-12345678');
  const cli = startCli(tmp);
  try {
    await sleep(800); // 让 setImmediate 基线扫描完成（连续文件 → 不吐行）
    assert.strictEqual(cli.lines.length, 0, '基线不吐行');
    appendFrame(file, [{ type: 'turn/start' }, { type: 'turn/end' }]);
    const start = await cli.waitType('turn-start', 16000); // fs.watch 未挂载（30s 对账前）→ 10s 兜底清扫
    assert.ok(start, '增量 turn/start 应经兜底清扫吐行');
    assert.strictEqual(start.sessionId, 'sess-t2-12345678');
    const ev = await cli.waitType('turn-end', 16000);
    assert.ok(ev, '增量 turn/end 应经兜底清扫吐行');
    assertProtocolShape(ev);
    assert.strictEqual(ev.sessionId, 'sess-t2-12345678');
    // 同帧 3 个 turn/end → 恰一行聚合（无 turn/start → 不吐 turn-start）。
    cli.lines.length = 0;
    appendFrame(file, [{ type: 'turn/end' }, { type: 'turn/end' }, { type: 'turn/end' }]);
    const ev2 = await cli.waitType('turn-end', 16000);
    assert.ok(ev2, '聚合帧应吐行');
    assert.ok(String(ev2.body).includes('（3 轮任务完成）'), '3 轮聚合后缀: ' + ev2.body);
    assert.strictEqual(ev2.count, 3, '聚合 turn/end 带 count=3');
    assertProtocolShape(ev2);
  } finally {
    await stopCli(cli.child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('cli: torn frame tail emits nothing until completed', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swcli-torn-'));
  const file = path.join(tmp, 'p1', 's3', 'session.jsonl.zstd');
  makeSessionFile(file, 'sess-t3-abcdefgh');
  const whole = frame([{ type: 'turn/start' }, { type: 'turn/end' }]);
  fs.appendFileSync(file, whole.subarray(0, whole.length - 4)); // 撕裂：截去尾部 4 字节
  const cli = startCli(tmp);
  try {
    await sleep(2500);
    assert.strictEqual(cli.lines.length, 0, '撕裂尾部不吐行');
    fs.appendFileSync(file, whole.subarray(whole.length - 4)); // 补齐
    const start = await cli.waitType('turn-start', 16000);
    assert.ok(start, '补齐后应吐 turn-start');
    assert.strictEqual(start.sessionId, 'sess-t3-abcdefgh');
    const ev = await cli.waitType('turn-end', 16000);
    assert.ok(ev, '补齐后应吐 turn-end');
    assertProtocolShape(ev);
    assert.strictEqual(ev.sessionId, 'sess-t3-abcdefgh');
  } finally {
    await stopCli(cli.child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('cli: delegationDepth>0 subagent log emits nothing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swcli-sub-'));
  const file = path.join(tmp, 'p1', 's4', 'session.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, frame([JSON.parse(header('sub-sess-1', { delegationDepth: 1 }))]));
  fs.appendFileSync(file, Buffer.from([0x01, 0x02, 0x03, 0x04]));
  fs.appendFileSync(file, frame([{ type: 'turn/end' }]));
  const cli = startCli(tmp);
  try {
    await sleep(3000);
    assert.strictEqual(cli.lines.length, 0, 'subagent 日志是通知噪声，不得吐行');
  } finally {
    await stopCli(cli.child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('cli: non-string session id → line carries sessionId:null (JS side)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swcli-nid-'));
  const file = path.join(tmp, 'p1', 's5', 'session.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, frame([{ type: 'session', id: 123, cwd: 'C:/fake' }]));
  fs.appendFileSync(file, Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]));
  fs.appendFileSync(file, frame([{ type: 'turn/end' }]));
  const cli = startCli(tmp);
  try {
    const ev = await cli.waitLine(5000);
    assert.ok(ev, '非字符串 id 的会话 JS 侧仍吐行（Electron 语义同向）');
    assert.strictEqual(ev.sessionId, null, 'JS CLI 把非字符串 id 映射为 null');
    assertProtocolShape(ev);
  } finally {
    await stopCli(cli.child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('cli: stdin close terminates process (orphan guard)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swcli-exit-'));
  const cli = startCli(tmp);
  await sleep(1000);
  assert.strictEqual(cli.child.exitCode, null, '运行中');
  cli.child.stdin.end();
  const deadline = Date.now() + 5000;
  while (cli.child.exitCode === null && Date.now() < deadline) await sleep(100);
  assert.notStrictEqual(cli.child.exitCode, null, 'stdin 关闭后应自退（父进程退出/被杀不留孤儿）');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('cli: missing sessions dir does not crash-loop; file delete race tolerated', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swcli-miss-'));
  const missing = path.join(tmp, 'no-such-dir');
  const cli = startCli(missing);
  try {
    await sleep(2500);
    assert.strictEqual(cli.child.exitCode, null, '目录缺失不应崩溃（listLogs 容错）');
    assert.strictEqual(cli.child.killed, false);
  } finally {
    await stopCli(cli.child);
  }
  // 会话文件监视中被删除：进程存活、无行、正常自退。
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'swcli-del-'));
  const file = path.join(tmp2, 'p1', 's6', 'session.jsonl.zstd');
  makeSessionFile(file, 'sess-t6-abcdefgh');
  const cli2 = startCli(tmp2);
  try {
    await sleep(800);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    await sleep(2000);
    assert.strictEqual(cli2.child.exitCode, null, '删除竞态不应崩溃');
    assert.strictEqual(cli2.lines.length, 0, '删除不产生行');
  } finally {
    await stopCli(cli2.child);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});
