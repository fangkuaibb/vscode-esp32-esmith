# Changelog

## 0.1.1

- 文档：补充与原生 `idf.py` 的对比（效率 / 稳定性 / 能力边界）
- 发布流程：打 tag 自动构建、生成 GitHub Release 并附带 VSIX；CI 统一使用 Node 22
- 首个可搜索的 Open VSX 版本（命名空间校验后生效）

## 0.1.0

首个公开版本。

- 闭环：`preflight → buildDevice → 烧录 → 复位 → 串口验证`，失败可重试与回退
- 36 个 MCP 工具：工程信息、构建烧录、串口、调试、经验记录
- 调试：断点、线程、调用栈、寄存器、变量求值、内存读写、watchpoint、GDB 命令通道、core dump 分析
- 串口：行缓冲采样、崩溃签名检测、实时镜像到输出面板
- 跨 IDE：VS Code 与 Trae 的 MCP 配置与 Agent 规则生成
- 多窗口按工程隔离 MCP 实例，复用官方扩展的串口、目标与 OpenOCD 状态
