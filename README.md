# ESmith

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.90.0-007ACC.svg)](https://code.visualstudio.com/)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6f42c1.svg)](https://modelcontextprotocol.io/)

ESP32 / ESP-IDF 闭环开发扩展，Trae 与 VS Code 通用：**编译 → 烧录 → 复位 → 串口验证 → Agent 自愈**，并把整套能力通过 MCP 暴露给 AI Agent。

ESmith 不重复造工具链。构建、烧录、目标切换、menuconfig、单元测试应用仍由官方 [`espressif.esp-idf-extension`](https://marketplace.visualstudio.com/items?itemName=espressif.esp-idf-extension) 执行；ESmith 负责把这些命令串成可验证、可恢复的闭环，并补齐官方扩展没有暴露给 Agent 的调试与诊断能力。

> 项目处于 `0.1.x` 早期阶段，MCP 工具的参数与返回结构可能继续调整；当前主要在 ESP32-S3（USB-JTAG / UART）与 ESP32-C3 上验证。

## 为什么是 ESmith

- **结果可验证**：不是“命令返回 0 就算成功”，而是结合官方 Task 退出码、官方日志、`Flashed Successfully` 标记与串口启动日志综合判定。
- **失败可恢复**：flash / verify 有独立重试预算，验证失败可回到烧录锚点；只匹配失败时不会白白重烧。
- **对 Agent 友好**：36 个 MCP 工具，覆盖工程信息、构建烧录、串口、调试、经验记录。
- **多项目隔离**：MCP 实例按工程登记，stdio 启动器按工作区匹配，多窗口互不串台。
- **与官方扩展共存**：复用官方已启动的 OpenOCD，不抢端口、不重复启动 GDB。

## 功能

### 闭环与构建

- 一键闭环：`preflight → 官方 buildDevice → 官方烧录 → 复位 → 串口验证`
- 失败恢复：flash / verify 独立重试预算、失败回退重烧、guard limit、锚点记录
- 构建诊断：从官方 Task 输出解析 GCC / CMake / Ninja 错误并去重，附带真实退出码
- 构建目录自检：识别 `build.ninja` 被追加 JSON 的损坏状态，快速失败并提示 clean 重建
- UART / JTAG / DFU：尊重 `idf.flashType`；JTAG 复用官方 OpenOCD

### 串口与验证

- 行缓冲采样、崩溃签名检测（`Guru Meditation`、`abort()`、`Stack canary` 等）
- 采样期间实时镜像到 `ESmith Serial` 输出面板
- `expectedPattern` / 波特率 / flashType 直接读磁盘配置，改完无需重载窗口

### 调试（基于官方 gdbtarget）

- 启动 / 停止、源码断点、函数断点、指令断点、条件与命中次数
- 线程/核列表、按线程看调用栈与寄存器
- 变量求值、内存读写
- **GDB 命令通道**：`info threads`、`monitor ...`、`x/4wx ...`、`set var` 等（REPL）
- **数据断点**：`watch` / `rwatch` / `awatch`，支持列出与清除
- 复位控制：`reset` / `reset_run` / `reset_to_app`
- OpenOCD adapter speed 可配置；USB-JTAG 链路异常有可操作提示
- Core dump 分析：ELF + core 文件输出每个线程的调用栈

### AI 集成

- MCP Server：Streamable HTTP + SSE，多会话、多客户端
- stdio 启动器：按工作区匹配实例，多窗口各连各的工程
- 跨 IDE：VS Code 写 `.vscode/mcp.json`（`servers` + stdio），Trae 写 `.trae/mcp.json` / 全局 `mcp.json`
- Agent 规则：根目录 `AGENTS.md` 作为唯一规则源（Codex 等默认读取）；Trae 的 `.trae/rules/esmith.md` 仅指向它；VS Code 同步完整内容到 `.github/copilot-instructions.md`
- Experience 引擎：`.esmith/experience/` 记录疑难修复经验并累计运行统计（项目级隔离）

## 架构

```text
官方 ESP-IDF 扩展
  └─ 工具链 / build / flash / setTarget / fullClean / OpenOCD

ESmith
  ├─ EspIdfBridge     调用官方命令；Task 日志 + 退出码 + 产物判定
  ├─ Pipeline         闭环 + Self-Healing（重试预算 / 锚点 / 回退）
  ├─ SerialService    串口采样、崩溃检测、实时镜像
  ├─ DebugService     gdbtarget DAP + GDB REPL；复用已有 OpenOCD
  ├─ DeviceResolver   官方选中的 COM 口 → OpenOCD USB 位置，避免多板抓错
  ├─ TapFixer         按 esp-config.json 修正 OpenOCD target IDCODE
  ├─ Doctor / Experience / MCP Server
  └─ Host 适配        VS Code / Trae
```

## 前置条件

- VS Code 或 Trae `^1.90.0`
- 已安装并初始化官方 ESP-IDF 扩展（建议 ESP-IDF `6.0.1+`）
- 已配置好 IDF 路径、工具链、串口与目标芯片
- Windows / macOS / Linux；串口原生依赖已随 VSIX 打包

## 安装

### 从源码打包安装

```powershell
npm install
npm run package
code --install-extension esmith-0.1.0.vsix --force
# Trae:
# trae-cn --install-extension esmith-0.1.0.vsix --force
```

安装后执行 `Developer: Reload Window`。

> Marketplace 发布流程尚未启用；当前以 VSIX / 源码安装为准。

## 快速开始

1. 在官方 ESP-IDF 扩展中选择 IDF、串口和目标芯片。
2. 运行 `ESmith: 集成体检`，确认工具链、OpenOCD、串口均可用。
3. 运行 `ESmith: 接入 AI（MCP + Agent 规则）`，一次完成：
   - 根目录 `AGENTS.md`：唯一规则源，Codex 等智能体默认读取
   - VS Code：项目 `.vscode/mcp.json`（stdio）+ `.github/copilot-instructions.md`
   - Trae：项目 `.trae/mcp.json`（HTTP）+ 全局 `mcp.json`（stdio，多窗口）+ `.trae/rules/esmith.md`（指向 `AGENTS.md`）
   - 运行 `ESmith: 初始化当前文件夹为 ESP-IDF 工程` 时也会自动执行
4. 运行 `ESmith: 一键闭环`，或让 Agent 调用 `esmith_closed_loop`。
5. 需要单步调试时，让 Agent 调用 `esmith_debug_start`，或使用侧边栏的 ESP32 视图。

## 命令

| 命令 | 说明 |
| --- | --- |
| `ESmith: 集成体检` | 检查官方扩展、IDF、目标、串口、OpenOCD |
| `ESmith: 初始化当前文件夹为 ESP-IDF 工程` | 初始化为 IDF 工程并接入 AI |
| `ESmith: 新建工程（选择父目录）` | Blank / Blink 模板 |
| `ESmith: 一键闭环（编译 → 烧录 → 验证）` | 完整闭环 |
| `ESmith: 停止当前任务` | 终止构建 / 烧录 / 采样 |
| `ESmith: 查看实时串口输出` | 打开串口监视与镜像面板 |
| `ESmith: 接入 AI（MCP + Agent 规则）` | 写 MCP 配置并生成 Agent 规则 |
| `ESmith: 注册 MCP` / `ESmith: 生成 Agent 规则` | 单独执行上述两步 |
| `ESmith: 清理残留 OpenOCD（3333）` | 先 TCL shutdown，失败再强制结束 |
| `ESmith: 刷新 IDF 信息` | 刷新侧边栏状态 |

## MCP 工具

### 工程与构建

| 工具 | 用途 |
| --- | --- |
| `esmith_project_info` | 工程、IDF、目标、串口、Flash 方式、生效配置及来源 |
| `esmith_doctor` | 集成体检 |
| `esmith_list_ports` | 串口列表（标记 USB-JTAG） |
| `esmith_init_project` | 初始化当前文件夹 |
| `esmith_set_target` | 切换目标芯片 |
| `esmith_build` / `esmith_flash` | 单独构建 / 烧录（支持 `clean`） |
| `esmith_closed_loop` | 一键闭环 |
| `esmith_unit_test` | 官方 Unity 单元测试应用 |
| `esmith_stop` | 停止当前任务 |

### 串口

| 工具 | 用途 |
| --- | --- |
| `esmith_monitor_start` / `esmith_monitor_stop` | 常驻串口监视 |
| `esmith_serial_tail` / `esmith_serial_search` / `esmith_serial_send` | 串口读写与检索 |
| `esmith_reset_device` | 标准复位（DTR 保持高，避免进入下载模式） |

### 调试

| 工具 | 用途 |
| --- | --- |
| `esmith_debug_start` / `esmith_debug_stop` | 启动 / 停止调试（默认停在 `app_main`） |
| `esmith_debug_state` | 停止原因、线程、PC、文件行号、调试警告 |
| `esmith_breakpoint_set` / `esmith_breakpoint_clear` / `esmith_breakpoint_list` | 断点管理 |
| `esmith_debug_control` | `continue` / `pause` / `step_*` / `reset` / `reset_run` / `reset_to_app` |
| `esmith_threads` | 线程（FreeRTOS task / 核）列表 |
| `esmith_backtrace` / `esmith_registers` | 调用栈 / 寄存器（可按线程） |
| `esmith_read_variable` | 变量或表达式求值 |
| `esmith_memory_read` / `esmith_memory_write` | 内存读写 |
| `esmith_watchpoint_set` / `esmith_watchpoint_list` / `esmith_watchpoint_clear` | 数据断点（watch / rwatch / awatch） |
| `esmith_gdb_command` | GDB 命令通道（REPL） |
| `esmith_coredump_analyze` | ELF + core 文件的线程调用栈分析 |

### 经验

| 工具 | 用途 |
| --- | --- |
| `esmith_query_experience` / `esmith_record_experience` | 经验查询 / 记录（项目级） |

## 配置

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `esmith.idfPath` | 空 | 手动指定 IDF 路径；留空自动读取官方扩展 |
| `esmith.flashBaudRate` | `460800` | 烧录波特率，写入超时可降到 `115200` |
| `esmith.monitorBaudRate` | `115200` | 串口监视与验证波特率 |
| `esmith.monitorMs` | `5000` | 闭环串口采样时长 |
| `esmith.expectedPattern` | 空 | 期望串口特征；留空只检查无崩溃与启动日志 |
| `esmith.retries` | `2` | 烧录 / 验证重试次数 |
| `esmith.reflashOnVerifyFailure` | `true` | 验证失败且仍有预算时回到烧录阶段 |
| `esmith.closedLoop.serialHint` | `true` | 采样时提示查看实时输出 |
| `esmith.closedLoop.serialMirror` | `true` | 串口日志镜像到输出面板 |
| `esmith.mcp.enabled` | `true` | 启用内置 MCP Server |
| `esmith.mcp.host` / `esmith.mcp.port` | `127.0.0.1` / `37821` | 监听地址与起始端口（占用时递增） |
| `esmith.mcp.autoRegister` | `true` | 仅在 ESP-IDF 工程中自动写项目 MCP 配置 |
| `esmith.mcp.autoRegisterGlobal` | `true` | Trae 下写全局 stdio 配置 |
| `esmith.mcp.timeoutMs` | `600000` | 写入 Trae HTTP MCP 的超时 |
| `esmith.agentRules.enabled` | `true` | 允许生成 / 更新 Agent 规则 |
| `esmith.agentRules.autoInstall` | `true` | 打开 IDF 工程时自动生成规则 |
| `esmith.openocd.autoFixTapId` | `true` | 修正 OpenOCD target `_CPUTAPID` 与 `esp-config.json` 不一致 |
| `esmith.openocd.scriptsPath` | 空 | 指定 OpenOCD scripts 目录；留空自动查找 |
| `esmith.openocd.adapterSpeed` | `0` | adapter speed（kHz），`0` 不覆盖；USB-JTAG 不稳时调低 |

## 目录约定

```text
AGENTS.md                 # Agent 规则源（ESmith 标记块，Codex 等默认读取）
.esmith/
  project.json            # 工程元信息
  experience/
    stats.json            # 运行统计（默认不提交）
    skills/*.json         # 疑难修复经验
.vscode/
  mcp.json                # VS Code 项目级 MCP（stdio）
.trae/
  mcp.json                # Trae 项目级 MCP（HTTP）
  rules/esmith.md         # 指向根目录 AGENTS.md
.github/
  copilot-instructions.md # VS Code Copilot 规则（完整内容，ESmith 标记块）
```

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `JTAG tap ... expected 0x120034e5` | 部分 OpenOCD 包的 `_CPUTAPID` 配置错误。保持 `esmith.openocd.autoFixTapId=true`，ESmith 会备份并修正 target cfg |
| `端口 3333 已被占用` | 若不是 OpenOCD，先释放端口；若是 OpenOCD，ESmith 会直接复用。需要释放时运行 `ESmith: 清理残留 OpenOCD（3333）` |
| `IN buffer overflow` / `missing data from bitq` | 重插 USB-JTAG，并把 `esmith.openocd.adapterSpeed` 降到 `1000`（或更低） |
| `build.ninja: ... lexing error` / `expected variable name` | 构建目录被写入 JSON（官方 CMake/Ninja 生成流程的问题）。执行 `esmith_build { clean: true }` 或 `ESmith: 一键闭环` 前先清理 |
| `Project ELF not found` | 先构建；`debug_start` 不会在缺少 ELF 时启动会话 |
| 多块板同时在线时抓错板 | ESmith 按官方扩展选中的 COM 口解析 USB 位置（`adapter usb location`）；请确认 `idf.port` 是目标板 |
| 烧录成功但串口验证失败 | 查看 `flashConfidence`：`verified` 为日志确认。pattern 不匹配时不会重复烧录，按返回的 `nextActions` 调整 `expectedPattern` |

## 开发

```powershell
npm run typecheck   # tsc --noEmit
npm test            # 编译测试并运行 46 项用例
npm run build       # esbuild 打包到 dist/
npm run watch       # 监听构建
npm run package     # typecheck + build + vsce package
```

### 目录结构

```text
src/
  core/       构建烧录桥接、闭环、串口、OpenOCD、诊断
  debug/      gdbtarget 调试服务与类型
  env/        IDF 发现与体检
  mcp/        MCP Server、实例登记、配置写入
  ui/         侧边栏与体检面板
  agent/      Agent 规则生成
  config.ts   配置读取（含绕过快照的 freshSetting）
  runtime.ts  扩展侧能力聚合
test/         node:test 用例
```

### 贡献

- 提交前确保 `npm run typecheck` 与 `npm test` 全部通过。
- 修改闭环 / 烧录判定时，请同步补充 `test/flashOutcome.test.ts` 或相关用例。
- 涉及 Windows 串口、USB-JTAG、多板并发的改动，请在 PR 描述中注明实测环境（芯片、COM、flashType）。
- 不要在代码或文档中提交真实设备序列号、MAC 地址等隐私信息。

## License

Apache-2.0
