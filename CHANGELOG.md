# Changelog

## 0.1.0

首个公开版本。

- 闭环：`preflight → buildDevice → 烧录 → 复位 → 串口验证`，失败可重试与回退
- 36 个 MCP 工具：工程信息、构建烧录、串口、调试、经验记录
- 调试：断点、线程、调用栈、寄存器、变量求值、内存读写、watchpoint、GDB 命令通道、core dump 分析
- 串口：行缓冲采样、崩溃签名检测、实时镜像到输出面板
- 跨 IDE：VS Code 与 Trae 的 MCP 配置与 Agent 规则生成
- 多窗口按工程隔离 MCP 实例，复用官方扩展的串口、目标与 OpenOCD 状态
