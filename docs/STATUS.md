# ESmith 第一版状态

> 更新时间：2026-10-19  
> 当前版本：`0.1.0`  
> VSIX：`E:\esmith\esmith-0.1.0.vsix`
>
> 说明：Self-Healing、Experience、闭环串口实时镜像、JTAG 调试均已实现。  
> 连接模式：**UART 与 JTAG 均已集成**；JTAG 调试与闭环已通过真实开发板测试（详见第 4、11 节）。

## 1. 当前定位

ESmith 是一个面向 Trae / VS Code 的 ESP32 闭环开发扩展。

设计原则：

- **官方 ESP-IDF 扩展负责工具链和环境**：编译、烧录、目标切换都调用官方扩展命令。
- **ESmith 负责闭环编排**：构建 → 烧录 → 复位 → 串口验证 → 结构化结果。
- **MCP 负责 AI 接入**：Trae Agent 通过 MCP 调用 ESMith，不需要自己拼 `idf.py` 命令。
- **人类操作不重复**：编译、烧录、选择串口、选择目标、串口监视器统一在官方 ESP-IDF 扩展中操作。

---

## 2. 已完成

### 2.1 扩展基础

- [x] TypeScript 扩展工程
- [x] esbuild 构建
- [x] VSIX 打包与安装
- [x] 命令、树视图、配置项
- [x] 类型检查 `tsc --noEmit` 通过
- [x] `serialport` 原生模块可用
- [x] VSIX 携带运行时依赖：`vsce package` 不带 `--no-dependencies`（`node_modules/serialport` 及其传递依赖已打包）
- [x] 中英文界面文案（`package.nls.json` / `package.nls.zh-cn.json`）
- [x] 单元测试（`node --test`）与 GitHub Actions CI
- [x] Apache-2.0 LICENSE 与 README

### 2.2 官方 ESP-IDF 扩展集成

- [x] 检测 `espressif.esp-idf-extension`
- [x] 激活官方扩展并检查命令可用性
- [x] 编译：`espIdf.buildDevice`
- [x] 烧录：`espIdf.flashUart`
- [x] 切换目标：`espIdf.setTarget`
- [x] 清理：`espIdf.fullClean`
- [x] 读取目标：`espIdf.getIDFTarget`
- [x] 读取工程名：`espIdf.getProjectName`
- [x] 构建诊断读取 VS Code Problems
- [x] 构建/烧录错误读取官方扩展日志 `esp_idf_vsc_ext.log`
- [x] 构建产物时间戳/存在性判据
- [x] `idf.currentSetup` 为空时自动写回解析到的 IDF 路径
- [x] 使用官方扩展的 `idf.buildPath` 作为构建目录
- [x] 串口选择以官方扩展的 `idf.port` 为准

### 2.3 闭环流水线

- [x] preflight：工程、官方命令、串口检查
- [x] build：调用官方扩展
- [x] flash：调用官方扩展
- [x] 复位：DTR/RTS
- [x] 串口采样
- [x] 期望特征匹配
- [x] 空输出保护
- [x] 崩溃签名检测
- [x] 烧录失败重试
- [x] 验证失败重试
- [x] 验证失败回退重烧
- [x] 结构化结果：`diagnostics`、`serial.tail`、`serial.crash`、`nextActions`

### 2.4 串口能力

- [x] 串口枚举与 ESP 设备识别
- [x] 单例串口连接
- [x] 行缓冲与环形缓冲
- [x] 串口发送
- [x] DTR/RTS 复位
- [x] 崩溃签名检测
- [x] `serial_tail` / `serial_search` / `serial_send` / `reset_device`
- [x] 串口异常提示（被占用、打不开）
- [x] 复位时序修正：DTR 保持 `false`（GPIO0 高），仅用 RTS 拉低 150ms 后释放，避免进入下载模式
- [x] 打开串口时默认 `dtr=false` / `rts=false`，避免打开动作本身拉低 GPIO0

### 2.5 MCP Server

- [x] 扩展内置 HTTP MCP Server
- [x] Streamable HTTP 端点 `/mcp`
- [x] SSE 兼容端点 `/sse` + `/messages`
- [x] `/health` 健康检查
- [x] 按工作区生成稳定端口，避免多窗口冲突
- [x] 自动补齐/回传 `Mcp-Session-Id`
- [x] 工具：
  - [x] `esmith_project_info`
  - [x] `esmith_doctor`
  - [x] `esmith_init_project`
  - [x] `esmith_list_ports`
  - [x] `esmith_set_target`
  - [x] `esmith_build`
  - [x] `esmith_flash`
  - [x] `esmith_monitor_start`
  - [x] `esmith_monitor_stop`
  - [x] `esmith_serial_tail`
  - [x] `esmith_serial_search`
  - [x] `esmith_serial_send`
  - [x] `esmith_reset_device`
  - [x] `esmith_closed_loop`
  - [x] `esmith_query_experience`
  - [x] `esmith_record_experience`
  - [x] `esmith_unit_test`
  - [x] `esmith_stop`
- [x] 多会话 / 多客户端（独立 Streamable HTTP transport）
- [x] `DELETE` 会话关闭后重新 initialize 自动重建
- [x] 无会话头的 initialize 使用 SDK `parsedBody`，不伪造 IncomingMessage
- [x] 单测覆盖 initialize / 多会话 / 未知会话 404（`test/mcpGateway.test.ts`）
- [x] 写入项目 `.trae/mcp.json`（HTTP，指向当前窗口端口）
- [x] 启动时自动写入项目 `.trae/mcp.json`（`esmith.mcp.autoRegister` 默认 `true`）
- [x] 全局 Trae `mcp.json` 使用 stdio 启动器（`esmith.mcp.autoRegisterGlobal` 默认 `true`）
- [x] `resources/mcp-stdio.js`：每个 Trae 窗口独立进程，按工作区匹配各自的 HTTP Server
  - [x] `/health` 返回 `projectRoot` 作为匹配依据
  - [x] 支持 `ESMITH_PORT` 固定端口直连
  - [x] 支持 `${workspaceFolder}` 未展开时回退到进程工作目录
  - [x] 父子目录前缀匹配（工作区位于工程子目录时也能连上）
- [x] 复制 MCP 配置到剪贴板（项目 HTTP / 全局 stdio）
- [x] 写入 `RUN_MCP_TIMEOUT_MS`，避免长构建超时
- [x] 已存在 `esmith` MCP 配置时自动同步端口
- [x] 宿主识别：VS Code / Trae（`src/host.ts`）
- [x] VS Code：`.vscode/mcp.json`，`servers` + `type: stdio` + `cwd: ${workspaceFolder}`
- [x] Trae：`.trae/mcp.json`（`mcpServers`，HTTP）+ 全局 stdio 启动器
- [x] `ESmith: 注册 MCP` 按宿主显示对应选项，不再写死 Trae
- [x] VS Code 使用项目级配置实现多窗口隔离，不写全局固定端口
- [x] 单测覆盖 VS Code / Trae 两种配置结构与合并写入

### 2.6 工程初始化

- [x] 命令：`ESmith: 初始化当前文件夹为 ESP-IDF 工程`
- [x] 模板：Blank（Hello World）
- [x] 模板：Blink（GPIO2）
- [x] 生成 `CMakeLists.txt`
- [x] 生成 `main/CMakeLists.txt`
- [x] 生成 `main/main.c`
- [x] 生成 `sdkconfig.defaults`
- [x] 生成 `.gitignore`
- [x] 合并/生成 `.vscode/settings.json`（JSONC 安全合并）
- [x] 写入 `idf.currentSetup`、`esmith.expectedPattern`
- [x] 生成 `.esmith/project.json`（工程元信息）
- [x] 生成 `.trae/rules/esmith.md`
- [x] 不覆盖已有文件
- [x] 已通过真实目录初始化验证
- [x] 支持选择父目录创建新工程（`esmith.newProject`）

### 2.7 UI 精简

- [x] 删除 ESmith 状态栏（与官方扩展重复）
- [x] 删除 `ESmith: 编译`
- [x] 删除 `ESmith: 烧录`
- [x] 删除 `ESmith: 选择串口`
- [x] 删除 `ESmith: 选择目标芯片`
- [x] 删除 `ESmith: 串口监视器`
- [x] 删除 ESMith 串口 Webview 面板
- [x] 保留：一键闭环、集成体检、初始化工程、注册 MCP、生成 Agent 规则、显示输出、停止、刷新

### 2.8 体检（Doctor）

- [x] 结果使用 `ESmith Doctor` 输出面板展示，不依赖 Webview（避免 ServiceWorker 注册失败）
- [x] 官方 ESP-IDF 扩展检查
- [x] 官方 build/flash/setTarget 命令检查
- [x] 工程结构检查
- [x] 当前 IDF 路径与版本检查
- [x] 版本 < 6.0.1 仅警告，不阻塞构建/烧录
- [x] 官方 MCP 能力提示
- [x] 目标芯片检查
- [x] 串口模块与串口列表检查
- [x] ESMith MCP Server 状态检查
- [x] 删除 `python_env` / 环境激活检查

### 2.9 Agent 规则

- [x] Trae：生成 `.trae/rules/esmith.md`
- [x] VS Code：生成 `.github/copilot-instructions.md`（标记块合并，保留已有内容）
- [x] ESP-IDF 工程启动时自动生成（`esmith.agentRules.autoInstall` 默认 `true`）
- [x] 说明构建/烧录由官方扩展执行
- [x] 说明优先使用 `esmith_closed_loop`
- [x] 说明失败后读取 `diagnostics` / `serial.crash` / `serial.tail`
- [x] 说明不要并发调用长任务
- [x] 明确禁止调用 `espsmith-cli.exe` 等外部 CLI

---

## 3. 已验证

- [x] `tsc --noEmit` 通过
- [x] VSIX 打包成功（约 1.26 MB）
- [x] VSIX 安装到 Trae 成功
- [x] MCP `/health` 正常
- [x] MCP `initialize` / `tools/list` / `tools/call` 正常
- [x] `esmith_project_info` 正常返回
- [x] `esmith_doctor` 正常返回
- [x] `esmith_list_ports` 正常返回
- [x] `esmith_init_project` 真实初始化目录成功
- [x] `serialport` 原生模块加载成功
- [x] 使用官方 EIM venv 实际执行 `idf.py build` 成功
- [x] 生成 `init_test.bin` / `init_test.elf`
- [x] Blink 工程初始化结果检查通过

---

## 4. 连接模式支持现状（UART / JTAG）

### 4.1 UART 模式：已集成

- 构建：官方 `espIdf.buildDevice`
- 烧录：官方 `espIdf.flashUart`
- 复位：DTR/RTS
- 验证：ESMith 串口采样 + 崩溃检测
- 串口来源：官方 `idf.port`，未设置时自动检测
- 状态：已通过真实开发板验证（CH340 / COM3）

### 4.2 JTAG 模式：烧录与调试均已集成

实机验证（2026-10-19）：JTAG 烧录、闭环验证、gdbtarget 调试、断点/单步/栈/变量全部 PASS。

已实现：

- [x] USB-JTAG 端口识别（VID `303a` / PID `1001`），串口列表中标记 `USB-JTAG`
- [x] 尊重官方 `idf.flashType`，不再硬编码 `espIdf.flashUart`
- [x] `idf.flashType = JTAG` 时优先 `espIdf.jtag_flash`，其次 `espIdf.flashDevice`
- [x] `idf.flashType = DFU` 时使用 `espIdf.flashDFU`
- [x] JTAG 烧录后继续用 ESMith 串口采样做运行验证
- [x] Doctor 增加“烧录方式”检查项
- [x] 烧录判定不依赖 VS Code Task：命令输出 / 官方日志 / 串口验证
  - `Flashed Successfully` / `Hash of data verified` → `verified`
  - 仅任务启动 → `task`
  - 无任务无日志但无错误 → `unconfirmed`，交由串口验证兜底
- [x] `FlashResult.confidence` 与 `ClosedLoopResult.flashConfidence`
- [x] 单测覆盖 JTAG 判定（`test/flashOutcome.test.ts`）

调试能力（通过官方 `gdbtarget` 会话）：

- [x] GDB PC / 栈 / backtrace 验证
- [x] 断点、变量、寄存器、内存读写
- [x] 数据断点 / 日志断点 / 条件断点 / 命中次数
- [x] OpenOCD 生命周期由官方扩展的 gdbtarget 配置提供者管理
- [x] `esmith_debug_control reset`（`monitor reset halt`）

约束：

- OpenOCD/GDB 由官方扩展管理，ESMith 不并发启动第二套 OpenOCD
- ESP32-S3/C3 的 USB-JTAG 存在硬件缓冲限制，需要真实板子验证
- JTAG 模式需要开发板支持 USB-JTAG 或外接 JTAG 探针

### 4.3 模式支持矩阵

| 能力 | UART | JTAG |
|---|---|---|
| 构建 | 已集成 | 已集成（同一构建流程） |
| 烧录 | 已集成 `flashUart` | 已集成 `jtag_flash` / `flashDevice` |
| 串口自动检测 | 已集成 | 已集成（标记 USB-JTAG） |
| 串口运行验证 | 已集成 | 已集成（与 UART 共用采样） |
| GDB PC / 栈验证 | 已集成（gdbtarget DAP） | 已集成（gdbtarget DAP） |
| 断点 / 变量 / 调用栈 | 已集成 | 已集成 |
| 失败恢复 | SerialReset + 重烧 | SerialReset + 重烧 |

### 4.4 调试工具（gdbtarget DAP）

实现方式：

- `vscode.debug.startDebugging` 启动官方扩展的 `gdbtarget` 会话
- 官方 `DebugConfigurationProvider` 负责填充 GDB/ELF 并管理 OpenOCD
- 所有操作通过 `activeDebugSession.customRequest` 发送 DAP 请求
- 不自行启动第二套 GDB/OpenOCD

工具：

- `esmith_debug_start` / `esmith_debug_stop` / `esmith_debug_state`
- `esmith_breakpoint_set` / `esmith_breakpoint_clear` / `esmith_breakpoint_list`
- `esmith_debug_control`（continue / pause / step_over / step_in / step_out / reset）
- `esmith_backtrace` / `esmith_registers`
- `esmith_read_variable` / `esmith_memory_read` / `esmith_memory_write`
- `esmith_watchpoint_set`（DAP dataBreakpoints）
- `esmith_gdb_command`（DAP evaluate, context=repl）
- `esmith_coredump_analyze`（ELF + core，复用 `core-dump.debug.session.ws`）

约束：

- 仅内置 USB-JTAG（S3 / C3 / C6 / H2 / P4 / C2）
- 调试与 build / flash / closed_loop 互斥
- 同一时间只允许一个调试会话

> [espIdfBridge.ts](../src/core/espIdfBridge.ts) 现在按 `idf.flashType`
> 选择 `flashUart` / `jtag_flash` / `flashDFU`，并在日志缺失时回退到 `flashDevice`。

---

## 5. 需求优先级与待办

排序原则：

- **P0**：第一版验收必须完成，否则不能称为“闭环可用”
- **P1**：核心能力与 AI 可靠性，决定 ESMith 和普通封装的差异
- **P2**：健壮性、体验和跨平台
- **P3**：生态与长期扩展

### P0：第一版验收（必须）

- [x] 在 Trae 中执行 `Developer: Reload Window`，加载最新 VSIX
- [x] 重新运行 `ESmith: 集成体检`，确认：
  - 官方 ESP-IDF 扩展：通过
  - 官方 ESP-IDF 命令：通过
  - 当前 IDF：通过
- [x] 使用真实开发板执行一次 UART 闭环
- [x] 确认官方 `espIdf.buildDevice` 在 ESMith 中调用成功
- [x] 确认官方 `espIdf.flashUart` 在 ESMith 中调用成功
- [x] 确认串口验证能捕获启动日志和崩溃日志
- [x] 在 Trae Agent 中实际连接 ESMith MCP，调用 `esmith_closed_loop`
- [x] 验证项目级 MCP 配置在 Trae 中生效
- [ ] 验证多根工作区下选择正确的 ESP-IDF 工程

### P1：核心竞争力（建议按此顺序）

1. **JTAG 模式**
   - [x] USB-JTAG 自动识别
   - [x] 尊重 `idf.flashType`，改为 `espIdf.flashDevice` / `espIdf.jtag_flash`
   - [x] JTAG 烧录 + 串口运行验证
   - [x] GDB PC / 栈 / 断点 / 变量 / 调用栈（实机 PASS）
2. **Self-Healing 通用引擎**
   - [x] 抽象 `RetryBudget` / `RecoveryPolicy` / `AnchorPoint` / `HealingEvent`
   - [x] build / flash / verify 独立重试预算
   - [x] 恢复动作、回退锚点、事件流
   - [x] guard limit（总尝试次数上限）
   - [x] 构建失败不自动重试，直接返回 diagnostics
   - [x] 烧录/验证失败自动复位 + 重试
   - [ ] P2：ProbeSoftReset / ProbeHardReset / GDB verify
3. **Experience 引擎**
   - [x] `.esmith/experience` stats / skills
   - [x] `esmith_query_experience` / `esmith_record_experience`
   - [x] 闭环结束自动更新 stats
   - [x] 失败结果附带经验提示
   - [x] 只有疑难修复才生成 skill（不自动生成）
   - [ ] P2：自动技能提取、全局共享、去重
4. **闭环串口实时镜像与提示**
   - [x] `ESmith Serial` OutputChannel
   - [x] “正在采样串口 COMx”提示
   - [x] “查看实时串口输出”按钮
   - [x] 提供“打开官方 ESP-IDF Monitor”按钮
   - [x] 配置项 `esmith.closedLoop.serialHint` / `serialMirror`

### P2：健壮性与体验

- [x] 烧录成功判定增强：轮询任务结束或 `Flashed Successfully` / `[/Flash]` / `Hash of data verified` 标记（最长 120s），失败标记与错误优先
- [x] 构建/烧录完整输出捕获：官方 `esp_idf_vsc_ext.log` 操作窗口内日志
- [x] MCP 多会话/多客户端支持
- [x] MCP `DELETE` 会话关闭后的自动重建
- [x] stdio MCP 启动器：每个窗口独立进程，按 `projectRoot` 匹配各自项目的 Server
- [ ] stdio 启动器多窗口实机验证（两个 Trae 窗口分别打开不同工程）
- [x] `.vscode/settings.json` 为 JSONC（带注释）时的安全合并
- [x] 构建失败时更精确地关联官方日志与任务
- [ ] macOS / Linux 实机验证
- [x] 确认人机串口监视器不再需要（当前已移除）

### P3：生态与长期扩展

- [x] 选择父目录创建新工程
- [x] Unity 单元测试：仅提供 MCP 工具 `esmith_unit_test` 给 Agent；界面入口使用官方扩展，不重复提供（pytest 未集成）
- [x] sdkconfig / menuconfig：由官方 ESP-IDF 扩展提供，ESmith 不重复实现
- [x] 中英文 i18n（`package.nls.json` / `package.nls.zh-cn.json`）
- [x] 单元测试与 CI（`node --test` + GitHub Actions）
- [x] LICENSE（Apache-2.0）
- [x] README
- [x] 发布流水线：`v*` tag 触发 CI 构建并上传 VSIX artifact（`.github/workflows/release.yml`）
- [x] 版本管理：`package.json` 版本号 + tag 驱动发布
- [ ] 使用截图（需要人工截取界面）

---

## 6. 两个引擎的集成（基础版已实现）

参考项目 `E:\AIstdio\espsmith` 里有两个很有价值的引擎：
`self_healing/` 和 `experience/`。ESmith 已经把两者的核心能力落入：

- `src/core/selfHealing.ts`：`RetryBudget` / `RecoveryPolicy` / `AnchorPoint` / guard limit
- `src/core/experience.ts`：stats / skills / 查询 / 记录
- 流水线 `src/core/pipeline.ts` 使用 Self-Healing 控制器驱动 flash / verify

### 6.1 Self-Healing 引擎

参考实现：

- `src-tauri/src/self_healing/types.rs`：`Step`、`Plan`、`RunResult`、`RetryBudget`、`RecoveryPolicy`、`AnchorPoint`
- `src-tauri/src/self_healing/runner.rs`：重试 → 恢复 → 回退锚点
- `src-tauri/src/self_healing/recovery.rs`：失败分类与恢复动作

核心思想：

```text
plan -> preflight -> build -> flash -> verify -> report
                 ↑         │         │
                 └─ recovery / rewind ─┘
```

映射到 ESMith：

| Self-Healing 概念 | ESMith 实现 |
|---|---|
| Build Step | `espIdf.buildDevice` |
| Load Step | `espIdf.flashUart` |
| Check Step | ESMith 串口采样 / 崩溃检测 |
| SerialReset | DTR/RTS 复位 |
| ProbeSoftReset / ProbeHardReset | 后续结合 JTAG / OpenOCD |
| GDB verify | 后续 JTAG 调试 |
| RetryBudget | build / flash / verify 分别配置 |
| AnchorPoint | build / flash / verify 回退点 |
| GuardLimit / Timeout | 总尝试次数与总超时保护 |

第一版已有能力：

- build / flash / verify 分阶段
- flash / verify 重试
- verify 失败后回退重烧
- 结构化事件与 `nextActions`

已实现：

- [x] `SelfHealingController`：flash / verify 独立重试预算
- [x] 恢复决策：`retry`（复位重试）/ `rewind`（重新烧录）/ `abort`
- [x] 回退锚点 `AnchorPoint` 与 `HealingSnapshot` 写入闭环结果
- [x] 事件流（attempt / retry / rewind / exhausted）写入日志与输出
- [x] guard limit：总尝试次数上限
- [x] 构建失败不自动重试，直接返回 diagnostics
- [x] 烧录/验证失败自动复位 + 重试

后续：

- [ ] 整体超时可配置
- [ ] P2：JTAG 场景接入 ProbeSoftReset / ProbeHardReset / GDB verify

约束：

- 构建/烧录仍由官方 ESP-IDF 扩展执行，不直接调用 `idf.py`
- 恢复动作只做官方扩展或串口层面能安全执行的操作
- 电源循环等需要人工介入的动作只提示，不自动执行

### 6.2 Experience 引擎

参考实现：

- `src-tauri/src/experience/engine.rs`
- `src-tauri/src/experience/storage.rs`
- 经验数据结构：`trigger` / `fix` / `lesson` / `scope`

目标：

- 记录每次闭环的结果统计
- 记录真正有价值的疑难修复经验
- AI 在遇到疑难时先查经验，修复后写回经验
- 避免重复踩同一个坑

存储建议：

```text
<项目>/.esmith/experience/
  ├─ stats.json          # runs / success / failure / stages / lastFailures
  └─ skills/<stable-id>.json
```

经验引擎固定按项目隔离：只读写 `<项目>/.esmith/experience`，不启用全局共享目录，避免不同项目的经验互相污染。

MCP 工具：

- [x] `esmith_query_experience(query, limit)`：查询历史经验
- [x] `esmith_record_experience(trigger, fix, lesson, scope)`：记录经验
- [x] 闭环结束后自动更新 run stats
- [x] 只有“非普通编译错误”的疑难修复才生成 skill（由 Agent 判断，不自动生成）
- [x] 失败结果附带 `experienceHints`
- [ ] P2：自动技能提取与去重（不做全局共享，保持项目级隔离）

隐私与安全：

- 不记录源码内容、密钥、Wi-Fi 密码等敏感信息
- 默认项目内存储，全局共享需显式开启
- 经验只作为提示，不自动修改代码

---

## 7. 闭环时同步观察串口（已实现）

实现：

- `ESmith Serial` OutputChannel 实时镜像串口行
- verify 阶段提示“正在采样串口 COMx”，提供“查看实时串口输出”和“打开 ESP-IDF 监视器”
- `esmith.closedLoop.serialHint` / `esmith.closedLoop.serialMirror` 默认开启

设计背景：

- 闭环验证时 ESMith 会独占串口进行采样
- 官方 ESP-IDF Monitor 无法同时打开同一个串口
- 用户希望在 IDE 中同步看到串口输出

建议方案：

1. **ESMith 串口实时镜像**
   - 新增独立的 `ESmith Serial` OutputChannel
   - 闭环采样时把串口行实时写入该通道，带时间戳
   - 不新增重复的 Monitor 面板，只是一个日志视图
2. **采样提示**
   - 进入 verify 阶段时弹出通知/进度：
     `ESMith 正在采样串口 COM5（5s）…`
   - 通知按钮：`查看实时串口输出`
   - 点击后打开 `ESmith Serial` 输出通道
3. **采样结束后**
   - 端口释放后提供 `打开官方 ESP-IDF Monitor`
   - 可选：提示用户复位设备以查看完整启动日志
4. **端口占用处理**
   - 如果检测到官方 Monitor 已占用串口，提示先关闭
   - 或直接使用 ESMith 镜像，不打开官方 Monitor
5. **MCP 路径**
   - `esmith_closed_loop` 由扩展宿主执行，同样可以弹通知
   - 返回结果仍包含 `serial.tail` 和 `serial.crash`
6. **配置项**
   - `esmith.closedLoop.serialHint`：是否显示采样提示，默认 `true`
   - `esmith.closedLoop.serialMirror`：是否写入 ESMith Serial 输出通道，默认 `true`

注意：

- 真正的“同时打开同一个串口”在多数 Windows 串口驱动上不可靠
- 因此“ESMith 镜像实时输出”比“同时打开两个 Monitor”更现实
- 官方 Monitor 适合闭环结束后的持续观察，不适合与闭环采样并发

---

## 8. 使用方式

1. 安装 `E:\esmith\esmith-0.1.0.vsix`
2. 在 Trae 中执行 `Developer: Reload Window`
3. 在官方 ESP-IDF 扩展中选择 IDF、串口和目标芯片
4. 运行 `ESmith: 集成体检`
5. 运行 `ESmith: 注册 MCP`（自动识别 VS Code / Trae）
   - 选择“写入全局 Trae mcp.json（stdio，多窗口推荐）”：适合同时打开多个工程
   - 或选择“写入项目 .trae/mcp.json（HTTP，单项目）”：需要开启“项目级 MCP”
6. 在 `设置 > MCP` 确认 `esmith` 已启用
7. 运行 `ESmith: 生成 Agent 规则`
8. 使用 `ESmith: 一键闭环`，或让 Trae Agent 调用 `esmith_closed_loop`

其他命令：

- `ESmith: 新建工程（选择父目录）`：在任意父目录创建 Blank / Blink 工程
- `ESmith: 查看实时串口输出`：打开 `ESmith Serial` 输出面板

多窗口 / 多项目隔离：

- MCP：每个窗口启动独立 Server；端口冲突时自动递增重试（最多 20 次）。
- 发现：扩展把实例登记到 `~/.esmith/servers/<hash>.json`（projectRoot + port）；stdio 启动器优先按登记实例匹配，并读取 `${workspaceFile}` 列出多根工作区的全部 root。
- 经验：固定存放在各自项目的 `.esmith/experience`，不同项目不共享。
- OpenOCD：优先使用官方插件选中 COM 口对应的 USB 位置（`adapter usb location`），多块同 VID/PID 的 USB-JTAG 同时在线时也不会抓错板；3333 已被占用时，调试/ JTAG 烧录会拒绝启动并提示，不会自动杀掉可能是另一个窗口的 OpenOCD；需要时使用 `ESmith: 清理残留 OpenOCD（3333）` 显式清理。
- 串口：被其它窗口或监视器占用时，错误信息会明确提示。
- 因此 `E:\esmith` 与 `E:\_esmith_bridge_test` 可以同时打开，各自调用各自的 `esmith_*` 工具。

---

## 9. 已知环境

- 官方 ESP-IDF 扩展：`espressif.esp-idf-extension` 2.3.0
- IDF 6.0.1：`E:\espeim\.espressif\v6.0.1\esp-idf`
- EIM Python：`C:\Espressif\tools\python\v6.0.1\venv`
- EIM 工具链：`C:\Espressif\tools`
- 官方扩展日志：`<extensionPath>\esp_idf_vsc_ext.log`
- 当前机器串口：`COM3`（CH340，ESP32-S3）+ `COM1`
- 已验证闭环：build / flash / monitor / serial_tail 通过；复位进下载模式问题已修正时序

---

## 10. 关键文件

- `src/core/espIdfBridge.ts`：官方 ESP-IDF 命令桥接
- `src/core/pipeline.ts`：闭环流水线
- `src/core/serialService.ts`：串口、环形缓冲、崩溃检测
- `src/core/projectInitializer.ts`：工程初始化
- `src/core/selfHealing.ts`：Self-Healing 预算 / 恢复 / 锚点
- `src/core/flashOutcome.ts`：烧录成功判定（UART / JTAG / DFU 通用）
- `src/core/experience.ts`：Experience stats / skills
- `src/core/jsonc.ts`：JSONC 解析与安全合并
- `src/env/idfLocator.ts` / `src/env/idfInfo.ts`：IDF 信息读取
- `src/env/doctor.ts`：集成体检
- `src/mcp/server.ts`：MCP Server（多会话）与工具
- `src/mcp/register.ts`：项目 HTTP / 全局 stdio MCP 配置写入
- `resources/mcp-stdio.js`：多窗口 stdio 启动器（按工作区匹配 Server）
- `src/agent/rules.ts`：Agent 规则生成
- `test/*.test.ts`：Self-Healing / Experience / JSONC / MCP Gateway 单元测试
- `src/ui/tree.ts`：ESMith 侧边栏
- `package.json`：命令、配置、VSIX 清单

---

## 11. 测试端反馈处理（2026-10-18）

| # | 反馈 | 处理 |
|---|---|---|
| 1 | JTAG 烧录固定等 500ms 容易误报 | 已改为轮询：任务结束 / `Flashed Successfully` / `[/Flash]`，最长 120s；无 Task 的 JTAG 最多等 20s 日志 |
| 2 | JTAG 成功后 `flashConfidence` 仍是 unconfirmed | 成功标记参与判定，日志或命令输出命中即为 `verified` |
| 3 | 规则提到 `esmith_generate_pins` 但工具不存在 | 已移除该工具与规则；测试工程 `.trae/rules/esmith.md` 已是最新 |
| 4 | `--no-dependencies` 漏掉 serialport | 已改为 `vsce package`，VSIX 包含 serialport 12.0.0 及依赖 |
| 5 | JTAG `IN buffer overflow` 无标准处理 | Doctor 增加 USB-JTAG 稳定性提示；README/Agent 规则加入“先断电重插，再降到 115200” |

P1/P2 需求（config/partition/size/chip/flash raw/NVS/component/unit-test 增强/serial expect；覆盖率/静态分析/RTT/FreeRTOS 统计/多设备）已记录，尚未实现。

补充（调试首轮测试 FAIL）：

| # | 反馈 | 处理 |
|---|---|---|
| 6 | gdbtarget 重复建立 GDB 连接（`target.parameters` + `connectCommands` 里的 `target remote`） | 已移除 `target.parameters`，只保留 `connectCommands` 中的一次 `target remote` |
| 7 | 启动失败后残留 OpenOCD 占用 3333 | 启动失败时检测 3333，确认进程名后按 PID 结束；`debug_stop` 也能清理候选实例 |
| 8 | 启动失败只返回统一错误 | 错误信息附带最近调试输出；launch 配置写入 ESmith 输出面板 |

ROM ELF、`freertos_gdb`、GDB host encoding 警告来自官方扩展的 gdbinit/工具链环境，不属于 ESmith 生成的 launch 配置。

调试复测（PASS）与闭环复测（PARTIAL）补充：

| # | 反馈 | 处理 |
|---|---|---|
| 9 | `build/gdbinit/symbols` 的 ROM ELF 路径缺少版本目录分隔符 | `debug_start` 前自动扫描并修正 `build/gdbinit/**`，无需手工修改 |
| 10 | `flashOutputTail` 只有占位文本 | 官方日志中的 `stdout` / `stderr` / `detail` 现在会进入 tail 与失败判定 |
| 11 | 闭环缺少独立烧录耗时 | 新增 `flashDurationMs` |
| 12 | JTAG 成功后 `flashConfidence` 仍 unconfirmed | 闭环 verify 通过后用串口反证，置为 `verified` 并标记 `flashVerifiedBy: "serial"` |
| 13 | `recovery.budgets.verify` 显示 max=2、used=3 | 对外 `max` 改为总尝试次数（重试数 + 1） |
| 14 | 无法区分“烧录成功但 pattern 不匹配”和“烧录失败” | verify 失败消息明确写出“烧录已成功，但串口验证未匹配 expectedPattern” |

官方扩展没有通过 VS Code API 暴露 OpenOCD 终端的完整 stdout，因此独立 `esmith_flash` 在 JTAG 下仍可能是 `unconfirmed`；`esmith_closed_loop` 会用串口启动结果反证。

错误 pattern 复测补充：

| # | 反馈 | 处理 |
|---|---|---|
| 15 | OpenOCD 启动失败被归到 `stage=build`，`buildOutputTail` 混入 OpenOCD stderr | 构建阶段过滤 OpenOCD/JTAG 日志条目，不再计入编译错误或 build tail |
| 16 | flash 阶段 OpenOCD 启动失败会残留进程 | JTAG 烧录失败时自动检测 3333 并按 PID 清理 openocd |

多根工作区复测补充（2026-10-19）：

| # | 反馈 | 处理 |
|---|---|---|
| 17 | 多根工作区下 ESmith MCP 未注册：`${workspaceFolder}` 只展开第一个非 IDF 文件夹，Trae 也只加载第一个 root 的 `.trae/mcp.json` | 新增 `~/.esmith/servers` 实例登记（每个工程一个文件）；stdio 启动器优先轮询本工作区期望端口，再按登记实例的 projectRoot 精确匹配；`${workspaceFile}` 列出全部 root |
| 18 | workspace 文件下 `idf.flashType` / `idf.port` / `openOcdConfigs` / `esmith.expectedPattern` 等 folder 级配置丢失，flashType 回退 UART | 所有 `idf.*` / `esmith.*` 读取改为带工程文件夹 URI（`src/config.ts`）；写回使用 `WorkspaceFolder` 目标；多根下初始化使用用户选中的文件夹 |
| 19 | OpenOCD 20260304 的 `target/esp32c3.cfg` 把 `_CPUTAPID` 写成 Xtensa 的 `0x120034e5`，而 C3 实际为 `0x00005c25`，导致 `JTAG tap ... UNEXPECTED`、`Unsupported DTM version: -1`，OpenOCD 无法启动 | JTAG 调试/烧录前按同包 `esp-config.json` 校验并自动修正（备份 `.esmith-bak`）；新增 `esmith.openocd.autoFixTapId` / `esmith.openocd.scriptsPath`。该失败与供电/接线无关，不能作为硬件判断依据 |
| 20 | stdio 启动器在扩展完成实例登记前读取注册表，触发“唯一实例回退”，把窗口绑到另一个工程（单根工作区也复现） | 删除跨工程回退；优先轮询本工作区全部 root 的期望端口；registry 仅接受 projectRoot 精确匹配或唯一前缀匹配；启动前 10s 不做全端口扫描；无工作区信息时才回退 cwd；`${workspaceFile}` 仅接受真实 `.code-workspace`；日志节流并输出候选实例 |
| 21 | 多块同 VID/PID（303A:1001）USB-JTAG 同时在线时，OpenOCD 按枚举顺序选设备，可能抓到别的板（S3 工程抓到 C3） | 按官方插件选中的 COM 口解析 USB 位置（Windows：PnP parent BusNumber/Address → `adapter usb location 1-3`），JTAG 调试/烧录前临时写入 `idf.openOcdLaunchArgs`（保留原 `idf.openOcdConfigs`），结束后恢复。本机验证 COM31→1-3（S3）、COM51→1-7（C3）均能精确选中 |
| 22 | build/flash 成功时 `outputTail` 只有提示；失败时缺少原始错误 | 读取官方扩展 Task 输出日志 `output_logging_.../N-ESP-IDF.log`：成功返回最后 50 行 + ELF/BIN 路径/大小/时间戳；失败再附带官方日志最近条目（本次时间窗为空时兜底）+ `[官方错误]` 行 + esptool/OpenOCD 原始输出 |
| 23 | 不知道 `expectedPattern` / 波特率 / `openOcdConfigs` 的生效值与来源，旧值导致闭环误判 | `esmith_project_info.effectiveConfig` 返回生效值及 folder/workspace/user/default 来源；`flashBaudRate` / `monitorBaudRate` 优先 `esmith.*`，未设置时回退 `idf.*`（兼容字符串形式的设置）；闭环开始时输出“生效配置”日志 |
| 24 | `esmith_flash { port: "COM99" }` 对不存在的串口返回 success；UART Task 失败但 exitCode 未参与判定 | 烧录前校验端口存在（不存在直接失败并列出可用串口）；TaskTracker 记录 `onDidEndTaskProcess` 退出码；exitCode≠0 或 Task 输出含 `Flash task failed` 判失败；Task 结束但无成功标记/退出码时不再当作成功 |
| 25 | 修改 `.vscode/settings.json` 后 `expectedPattern` 不生效，闭环按旧值白烧两次 | 新增 `freshSetting()` 直接读取 folder `.vscode/settings.json` / `.code-workspace`，用于 expectedPattern、flashType、port、波特率、openOcdConfigs；闭环 preflight 重新读取并输出来源；仅 pattern 不匹配且烧录已成功时不再回退重烧，直接失败并提示当前值与来源 |
| 26 | 成功 build/flash 的 outputTail 混入整段 PATH / SYSTEM_PATH / IDF_* 环境变量 | Task 输出过滤环境变量行，只保留 `[Build]`/`[Flash]`、ninja、内存统计、esptool 等正文 |
| 27 | 官方 ESP-IDF 扩展已启动 OpenOCD 时，ESmith 报 3333 被占用；JTAG 烧录后残留 OpenOCD 阻塞后续操作 | 3333 上是 OpenOCD 时直接复用：debug 用 `runOpenOCD=false` 连接已有 GDB server；flash 交给官方扩展复用。JTAG 烧录后不再自动停止 OpenOCD（与官方扩展一致），后续操作继续复用；需要释放时用显式清理命令 |
| 28 | 复用已有 OpenOCD 时，官方扩展仍尝试连接 GDB 被拒，ESmith 把 `attempted 'gdb' connection rejected` 当成烧录失败（实际已 Flashed Successfully） | 复用模式下过滤 `OpenOCD server failed to start` / `gdb connection rejected` 噪声（轮询、错误列表、Task 输出、outputTail 全部过滤），结果以 Flashed Successfully / Flash Done 为准 |
| 29 | JTAG 烧录成功后直接 kill OpenOCD，官方扩展反复弹 “OpenOCD exited with error code 1” | 烧录后不再自动停止 OpenOCD，消除弹窗根源；显式清理命令先尝试 TCL `shutdown`（端口 6666），超时或不可用才回退 `killPid` |
| 30 | watchpoint/gdb_command 不可用却建议改用对方；debug_control reset 缺 frameId；`idf.port` 无效时 build 卡 98s；debug_start 失败不带官方原因 | watchpoint/gdb_command 返回明确的“适配器不支持”错误并给出可用替代工具；reset 先 pause 再带 frameId；build 前校验 `idf.port` 存在；debug_start 失败附加官方日志最近 6 行 |
| 31 | ELF 缺失时 `debug_start` 仍然启动 gdbtarget，等不到 app_main，60s 后拖死 MCP 会话 | 启动前检查 ELF 存在，缺失直接返回 `Project ELF not found in <build>` + 官方日志尾部；`waitForStop` 超时降为 15s，超时主动 `stopDebugging` 并返回结构化错误 |
| 32 | 构建失败（`ninja: build stopped`）时 `errors=[]`，无法定位；Task 退出码未参与 build 判定 | 解析官方 Task 输出中的 GCC/CMake/Ninja 诊断并合并进 `errors`；`onDidEndTaskProcess` 退出码≠0 直接判失败；返回真实 exitCode |
| 33 | 官方扩展把 `compile_commands.json` 内容追加到 `build.ninja` 尾部，后续增量构建失败 | 构建前检查 `build.ninja` 尾部是否为 JSON（`"directory"` + `"file"`），命中直接失败并提示 `esmith_build { clean: true }`；ESmith 不写入构建文件，也不自动删除构建目录 |
| 34 | 损坏预检只认分行 JSON，单行追加的 `{"directory":"x","file":"y"}` 未触发；构建仍白跑一次 | 预检改为在文件尾部匹配 `"directory"\s*:` 与 `"file"\s*:`（不要求行首/空格）；同时把 ninja 的 `lexing error` / `expected variable name` 映射为“构建目录已损坏，请 clean” |
| 35 | 同一个编译错误在 `errors` 里出现两次（路径大小写/分隔符不同） | `mergeDiagnostics` 统一小写 + 正斜杠后按 file+line+message 去重 |
| 36 | ELF 预检失败时附带无关的官方日志（esptool 连接超时），误导排查 | 只保留官方日志中包含 `ELF` 的行 |
| 37 | `esmith_gdb_command` 报“无 REPL 通道”；`debug_control reset` 无法执行 monitor | 改用 gdbtarget 的 REPL 约定：`evaluate.expression = ">命令"`、`context=repl`；输出从 output 事件收集；新增 `reset_run` / `reset_to_app`（tbreak app_main） |
| 38 | 数据断点不支持 | 通过 GDB REPL 设置 `watch` / `rwatch` / `awatch`，解析 GDB watchpoint 编号；新增 `esmith_watchpoint_list` / `esmith_watchpoint_clear` |
| 39 | 无法按核/线程看寄存器 | 新增 `esmith_threads` 列出 DAP 线程（FreeRTOS task / 核）；`esmith_registers` 支持 `thread` 参数 |
| 40 | USB-JTAG 只能手改 launch args 降速；IN buffer overflow 时无提示 | 新增 `esmith.openocd.adapterSpeed`（kHz），调试/烧录时注入 `adapter speed` 并输出到日志；检测到 `IN buffer overflow` / `missing data from bitq` 时给出“重插 + 降速”提示 |

验收状态（2026-10-20）：JTAG 调试、JTAG 闭环、UART 闭环、错误 pattern 文案均 PASS。多根工作区 P0/P1 已修复；多窗口实例串台（启动时序竞争）已修复，待复测。
