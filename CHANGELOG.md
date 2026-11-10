# Changelog

## 0.1.0

首个公开预览版本。

- 闭环：preflight → 官方 build → 官方烧录 → 复位 → 串口验证，失败按预算重试与回退
- 串口：行缓冲采样、崩溃签名检测、采样期实时镜像到 `ESmith Serial`
- 调试：基于官方 gdbtarget 的启动/停止、断点、线程与寄存器、变量与内存、GDB 命令通道、数据断点、core dump 分析
- MCP：Streamable HTTP + stdio 启动器，按工作区匹配实例；36 个工具覆盖工程信息、构建烧录、串口、调试、经验记录
- AI 接入：一键写 VS Code / Trae 的 MCP 配置，生成 `AGENTS.md` 并同步 `copilot-instructions.md`
- 支持 UART / JTAG / DFU 烧录，JTAG 复用官方已启动的 OpenOCD
- 依赖官方 [`espressif.esp-idf-extension`](https://marketplace.visualstudio.com/items?itemName=espressif.esp-idf-extension)
