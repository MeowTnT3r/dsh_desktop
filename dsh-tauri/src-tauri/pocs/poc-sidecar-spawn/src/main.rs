//! PoC-C：Rust 拉起 dsh 内核并解析就绪行（Phase 0 三大硬验收之一）。
//!
//! 验证链路：`kernel-process::SpawnSpec`（含 rc.8 `--no-open` 门控）→
//! `std::process::Command`（环境白名单净化）→ 流式 stdout →
//! `ReadyLineParser` 命中 `dsh web: https://...` → `taskkill /T /F` 杀树。
//!
//! 用法（仓库根目录）：
//! ```text
//! cargo run -p poc-sidecar-spawn -- [--repo <dsh-desktop 路径>] [--timeout 120]
//! ```
//! 默认 repo = 本仓库的 `dsh-desktop/`（需已 `npm install`，含
//! `vendor/node/node.exe` 与 `node_modules/@deepseek-ai/dsh`）。
//! 退出码：0 = PASS，1 = FAIL，2 = 环境缺失。

use kernel_process::{choose_stable_port, ReadyLineParser, SpawnSpec};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn main() {
    let mut repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../dsh-desktop");
    let mut timeout_secs: u64 = 120;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--repo" => repo = PathBuf::from(args.next().unwrap_or_default()),
            "--timeout" => timeout_secs = args.next().and_then(|v| v.parse().ok()).unwrap_or(120),
            _ => {}
        }
    }
    // 路径里含 .. 时规范化，避免 spawn 时 cwd 解析歧义。
    let repo = normalize(&repo);

    let node_exe = repo.join("vendor/node/node.exe");
    let pkg = repo.join("node_modules/@deepseek-ai/dsh/package.json");
    let bin_js = repo.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
    for (what, p) in [("vendor node", &node_exe), ("内核 package.json", &pkg), ("内核 bin.js", &bin_js)] {
        if !p.exists() {
            eprintln!("[PoC-C] 环境缺失：{what} 不存在：{}", p.display());
            eprintln!("[PoC-C] 请在 dsh-desktop/ 先执行 npm install，或用 --repo 指定路径");
            std::process::exit(2);
        }
    }

    let kernel_version = read_version(&pkg);
    println!("[PoC-C] 内核版本 = {kernel_version}");

    // 就绪前先起本地探活页：证明「壳先起、内核后起」的启动次序可行（Electron 同款）。
    let port = match choose_stable_port(None) {
        Some(p) => p,
        None => {
            eprintln!("[PoC-C] FAIL：无可用安全端口");
            std::process::exit(1);
        }
    };

    let spec = SpawnSpec::new(&node_exe, &bin_js, &kernel_version, port, &[], true);
    println!("[PoC-C] spawn: {}", spec.display_cmd());

    let mut env_cmd = Command::new(&spec.node_exe);
    env_cmd.args(&spec.node_args).arg(&spec.bin_js).args(&spec.web_args);
    env_cmd.env_remove("DSH_DESKTOP"); // 壳变量不外溢
    // 环境白名单（spawn_spec::ENV_ALLOWLIST）：只透传必需变量。
    for (k, v) in std::env::vars() {
        if spec.env_allow.iter().any(|a| a.eq_ignore_ascii_case(&k)) {
            env_cmd.env(k, v);
        }
    }
    env_cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());

    let start = Instant::now();
    let mut child = match env_cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[PoC-C] FAIL：spawn 失败：{e}");
            std::process::exit(1);
        }
    };
    let pid = child.id();
    println!("[PoC-C] 内核 pid={pid}，等待就绪行（超时 {timeout_secs}s）…");

    let mut stdout = child.stdout.take().expect("stdout piped");
    let mut parser = ReadyLineParser::new();
    let mut chunk = [0u8; 4096];
    let mut url: Option<String> = None;
    let deadline = start + Duration::from_secs(timeout_secs);
    while Instant::now() < deadline {
        match stdout.read(&mut chunk) {
            Ok(0) => break, // 进程退出
            Ok(n) => {
                let text = String::from_utf8_lossy(&chunk[..n]).into_owned();
                for line in text.lines().filter(|l| !l.trim().is_empty()).take(8) {
                    println!("      | {line}");
                }
                if let Some(u) = parser.feed(&text) {
                    url = Some(u);
                    break;
                }
            }
            Err(e) => {
                eprintln!("[PoC-C] FAIL：stdout 读取错误：{e}");
                kill_tree(pid);
                std::process::exit(1);
            }
        }
    }

    kill_tree(pid);
    let _ = child.wait();

    match url {
        Some(u) => {
            let elapsed = start.elapsed().as_secs_f64();
            println!();
            println!("[PoC-C] PASS：就绪 URL = {u}（{elapsed:.1}s，pid {pid} 已终结）");
            println!("[PoC-C] 结论：Rust 壳 → vendor-node → dsh web → 就绪行解析 链路打通");
            std::process::exit(0);
        }
        None => {
            let mut stderr = child.stderr.take().map(|mut s| {
                let mut b = String::new();
                let _ = s.read_to_string(&mut b);
                b
            }).unwrap_or_default();
            if stderr.len() > 2000 {
                stderr = format!("…{}", &stderr[stderr.len() - 2000..]);
            }
            eprintln!("[PoC-C] FAIL：{timeout_secs}s 内未见到就绪行。stderr 尾部：\n{stderr}");
            std::process::exit(1);
        }
    }
}

fn read_version(pkg: &Path) -> String {
    let raw = std::fs::read_to_string(pkg).unwrap_or_default();
    // 最小化解析："version": "x.y.z-rc.n" —— 冒号后第一对引号内的内容（避免为此拉 serde）。
    if let Some(pos) = raw.find("\"version\"") {
        if let Some(colon) = raw[pos..].find(':') {
            let rest = &raw[pos + colon..];
            if let Some(q1) = rest.find('"') {
                if let Some(len) = rest[q1 + 1..].find('"') {
                    return rest[q1 + 1..q1 + 1 + len].to_string();
                }
            }
        }
    }
    "unknown".into()
}

fn kill_tree(pid: u32) {
    // Electron 版结论（main.js 610-624）：控制台进程只能 /T /F 强杀，优雅 kill 无效。
    let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
}

fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        use std::path::Component::*;
        match c {
            Prefix(_) | RootDir => out.push(c.as_os_str()),
            CurDir => {}
            ParentDir => {
                out.pop();
            }
            Normal(n) => out.push(n),
        }
    }
    out
}
