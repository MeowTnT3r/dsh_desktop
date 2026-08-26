//! spawn 规格构造。
//!
//! 对齐 Electron 版 main.js startServer 的最终 spawn 命令：
//! ```text
//! <vendor-node> --use-system-ca --expose-internals [--require web-crash-shield.js]
//!   <bin.js> web [--patch <overlay>]... [--no-open] --host 127.0.0.1 --port <port>
//! ```
//! **参数位置契约**（rc.8 实证）：
//! - `--use-system-ca` / `--expose-internals` / `--require` 是 **node 级**参数，
//!   必须位于 bin.js 之前；
//! - `--expose-internals`（W1 修复，2026-08）：内核 cordis-plugin-loader 经
//!   `process.execArgv.includes("--expose-internals")` 才能取到 Node 内部 ESM
//!   loader（`loader.internal`）——HMR 插件无条件要求它，且 profiles/web 下
//!   插件的裸包名 import 依赖 internal loader 解析；缺失则内核启动即崩
//!   （"--expose-internals is required for HMR service"）；
//! - `web` 是子命令（`--profile web` 的别名）；`--patch` / `--no-open` / `--host` /
//!   `--port` 是 **web 子命令参数**，必须位于 `web` 之后——放前面会被父级解析器
//!   拒绝（"error: --profile <name> is required"）；
//! - `--patch` 必须位于 `--host` 之前（web 会把第一个应用参数后的内容透传，
//!   Electron 版 main.js 有同款注释）。
//!
//! 环境净化（Electron 版 shieldArgs 的等价物）：白名单透传，见 [`ENV_ALLOWLIST`]。
//! 本模块产出 `SpawnSpec`，真实 spawn 在 Phase 1 的 supervisor（Windows Job
//! Object 绑定）。

use crate::semver;

/// 一次内核 spawn 的完整参数。
#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub node_exe: std::path::PathBuf,
    pub bin_js: std::path::PathBuf,
    /// node 级参数（bin.js 之前）。
    pub node_args: Vec<String>,
    /// web 子命令参数（bin.js 之后，含 `web` 本身）。
    pub web_args: Vec<String>,
    pub env_allow: Vec<String>,
}

/// 构造 web 子命令参数（`web` 开头）。
///
/// `kernel_version`：`@deepseek-ai/dsh` 的 package.json version。
/// `port`：已探测的安全端口。
/// `patch_yml`：overlay 补丁清单（Phase 2 起非空）。
pub fn web_args(kernel_version: &str, port: u16, patch_yml: &[std::path::PathBuf]) -> Vec<String> {
    let mut args: Vec<String> = vec!["web".into()];
    for p in patch_yml {
        args.push("--patch".into());
        args.push(p.to_string_lossy().into_owned());
    }
    if semver::needs_no_open_flag(kernel_version) {
        args.push("--no-open".into());
    }
    args.push("--host".into());
    args.push("127.0.0.1".into());
    args.push("--port".into());
    args.push(port.to_string());
    args
}

/// node 级参数（对齐 Electron：证书修正 + internal loader 暴露 + 崩溃屏蔽 require）。
/// `--use-system-ca`：仅当调用方确认目标 node 支持时注入（`use_system_ca=true`）；
/// 系统 node 为 22.0–22.14 时该 flag 尚不存在（`bad option`，退出码 9，issue #163），
/// 撤下后 TLS 退回内置 CA，内核照常启动。`--expose-internals`：node 级参数
/// （execArgv），内核 loader 据此取 Node 内部 ESM loader——HMR 服务与 profiles 插件的
/// 裸包名 import 都依赖（W1 问题一）。崩溃屏蔽文件不存在时不注入（dev 检出兜底，
/// Electron 同款）。
pub fn node_args(crash_shield: Option<&std::path::Path>, use_system_ca: bool) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if use_system_ca {
        args.push("--use-system-ca".to_string());
    }
    args.push("--expose-internals".to_string());
    if let Some(shield) = crash_shield {
        if shield.exists() {
            args.push("--require".into());
            args.push(shield.to_string_lossy().into_owned());
        }
    }
    args
}

/// WSL 包装 spawn 的 wsl.exe argv（契约 wsl-backend.md §4.3 / design D2）：
/// `["-d", <distro>, "-e", "sh", "-lc", <cmd>]`——严格独立 argv 单词
/// （wsl.exe 只接受 `--` 后按空格拆开的 argv；整条命令拼一个带空格的字符串
/// 会被当单词直接 exec 失败）。`-e` 跳过默认 shell 二次解析；`sh -lc` 登录
/// shell 使 fnm/nvm 的 node 进 PATH（**不双重嵌套登录 shell**——Electron 已
/// 清理过该问题）。cmd 内已含 `cd`/pid 文件/`exec node`，由调用方经
/// wsl-backend crate 的 spec 构造。
pub fn wsl_spawn_args(distro: &str, cmd: &str) -> Vec<String> {
    vec!["-d".into(), distro.into(), "-e".into(), "sh".into(), "-lc".into(), cmd.into()]
}

/// 子进程环境白名单（Windows 必需集 + node 运行必需集）。
/// Electron 版 shieldArgs 的语义：**白名单**而非黑名单（防泄漏任意父进程变量）。
pub const ENV_ALLOWLIST: &[&str] = &[
    "SystemRoot",
    "windir",
    "PATH",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "HOME",
    "COMSPEC",
    "PATHEXT",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "LANG",
    "DSH_HOME",
];

impl SpawnSpec {
    pub fn new(
        node_exe: impl Into<std::path::PathBuf>,
        bin_js: impl Into<std::path::PathBuf>,
        kernel_version: &str,
        port: u16,
        patch_yml: &[std::path::PathBuf],
        use_system_ca: bool,
    ) -> Self {
        Self {
            node_exe: node_exe.into(),
            bin_js: bin_js.into(),
            node_args: node_args(None, use_system_ca),
            web_args: web_args(kernel_version, port, patch_yml),
            env_allow: ENV_ALLOWLIST.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// 完整命令行（日志友好）。
    pub fn display_cmd(&self) -> String {
        format!(
            "{} {} {} {}",
            self.node_exe.display(),
            self.node_args.join(" "),
            self.bin_js.display(),
            self.web_args.join(" ")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn rc7_has_no_flag_rc8_has() {
        assert!(!web_args("0.1.0-rc.7", 5000, &[]).contains(&"--no-open".to_string()));
        assert!(web_args("0.1.0-rc.8", 5000, &[]).contains(&"--no-open".to_string()));
    }

    #[test]
    fn arg_shape_matches_electron() {
        // Electron：node --use-system-ca --expose-internals bin.js web --patch X --no-open --host 127.0.0.1 --port N
        let args = web_args("0.1.0-rc.8", 51731, &[PathBuf::from("/ov/cordis.patch.yml")]);
        assert_eq!(
            args,
            vec![
                "web",
                "--patch", "/ov/cordis.patch.yml",
                "--no-open",
                "--host", "127.0.0.1",
                "--port", "51731",
            ]
        );
        // web 子命令必须排首位（--patch/--no-open 在 web 之后，父级才不会报 profile 缺失）。
        assert_eq!(args.first().map(String::as_str), Some("web"));
        let web_pos = args.iter().position(|a| a == "web").unwrap();
        let patch_pos = args.iter().position(|a| a == "--patch").unwrap();
        let host_pos = args.iter().position(|a| a == "--host").unwrap();
        assert!(web_pos < patch_pos && patch_pos < host_pos, "顺序：web < --patch < --host");
    }

    #[test]
    fn node_level_args_before_bin() {
        let spec = SpawnSpec::new("node.exe", "bin.js", "0.1.0-rc.8", 5000, &[], true);
        // W1 问题一：--expose-internals 必须在场（HMR/internal loader 依赖 execArgv 探测）。
        assert_eq!(spec.node_args, vec!["--use-system-ca", "--expose-internals"]);
        assert_eq!(spec.web_args.first().map(String::as_str), Some("web"));
        let shield = PathBuf::from("/definitely/missing-shield.js");
        assert_eq!(
            node_args(Some(&shield), true),
            vec!["--use-system-ca", "--expose-internals"],
            "屏蔽文件不存在时不注入"
        );
        // 屏蔽文件存在时：require 注入在 expose-internals 之后（同为 node 级、bin.js 之前）。
        let real = std::env::temp_dir();
        let shield_arg = real.to_string_lossy().into_owned();
        assert_eq!(
            node_args(Some(&real), true),
            vec!["--use-system-ca".to_string(), "--expose-internals".to_string(), "--require".to_string(), shield_arg]
        );
    }

    #[test]
    fn node_args_drops_use_system_ca_when_unsupported() {
        // issue #163：系统 node 22.0–22.14 不支持 --use-system-ca，必须撤下该 flag，
        // 但 --expose-internals 仍在（内核 HMR/internal loader 依赖）。
        assert_eq!(
            node_args(None, false),
            vec!["--expose-internals"],
            "不支持时撤下 --use-system-ca，保留 --expose-internals"
        );
        let spec = SpawnSpec::new("node.exe", "bin.js", "0.1.0-rc.8", 5000, &[], false);
        assert_eq!(spec.node_args, vec!["--expose-internals"]);
    }

    #[test]
    fn env_allowlist_excludes_node_and_electron() {
        assert!(!ENV_ALLOWLIST.contains(&"NODE_OPTIONS"));
        assert!(!ENV_ALLOWLIST.contains(&"ELECTRON_RUN_AS_NODE"));
        assert!(ENV_ALLOWLIST.contains(&"SystemRoot"));
    }

    /// WSL 包装 argv：严格独立单词（无空格拼接）、参数序 -d → -e → sh -lc → cmd。
    #[test]
    fn wsl_spawn_args_strict_argv_shape() {
        let cmd = "cd /opt/d && exec node bin.js web --port 0";
        let args = wsl_spawn_args("Ubuntu-24.04", cmd);
        assert_eq!(args, vec!["-d", "Ubuntu-24.04", "-e", "sh", "-lc", cmd]);
        // distro 含空格也必须是单个 argv（经 wsl.exe argv 传递，不拼命令串）。
        let spaced = wsl_spawn_args("Ubuntu 24.04 LTS", "x");
        assert_eq!(spaced[1], "Ubuntu 24.04 LTS");
        // cmd 整串原样单个 argv（不按空格拆）。
        assert_eq!(wsl_spawn_args("D", "a b c").len(), 6);
        assert_eq!(wsl_spawn_args("D", "a b c")[5], "a b c");
    }
}
