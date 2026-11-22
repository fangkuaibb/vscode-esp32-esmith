ESP32 / ESP-IDF 闭环开发扩展：编译 → 烧录 → 复位 → 串口验证 → Agent 自愈，并通过 MCP 暴露给 AI Agent。

- 36 个 MCP 工具，覆盖工程、构建烧录、串口、调试与经验记录
- 闭环判定综合官方日志、`Flashed Successfully` 与串口启动日志，不只看退出码
- UART / JTAG / DFU 均按 `idf.flashType` 执行，JTAG 复用官方 OpenOCD
- 断点、线程、调用栈、寄存器、内存读写、watchpoint、GDB REPL、core dump 分析
- VS Code 与 Trae 通用，多窗口按工程隔离 MCP 实例

**安装**：下载下方 `esmith-*.vsix`，执行 `code --install-extension <文件名> --force`（Trae 用 `trae-cn`）。

**文档**：https://github.com/fangkuaibb/vscode-esp32-esmith#readme
