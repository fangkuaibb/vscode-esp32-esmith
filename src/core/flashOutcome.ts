export type FlashConfidence = 'verified' | 'task' | 'unconfirmed';

export interface FlashOutcomeInput {
  flashType: string;
  aborted: boolean;
  errors: string[];
  commandOutput?: string;
  logMessages?: string[];
  taskStarted?: boolean;
  /** VS Code Task 的退出码；0 表示进程成功结束。 */
  exitCode?: number;
  /** 官方扩展 Task 输出日志（output_logging_.../N-ESP-IDF.log）。 */
  taskOutput?: string;
}

export interface FlashOutcome {
  success: boolean;
  confidence: FlashConfidence;
  message: string;
}

const SUCCESS_PATTERN =
  /flashed successfully|hash of data verified|flash.*(done|success)|leaving\.\.\.|\[\/flash\]/i;
const FAILED_PATTERN =
  /(flash|write).*(failed|error)|failed to (flash|write)|fatal error/i;

export function matchesFlashSuccess(text: string): boolean {
  return SUCCESS_PATTERN.test(String(text ?? ''));
}

export function matchesFlashFailure(text: string): boolean {
  return FAILED_PATTERN.test(String(text ?? ''));
}

/**
 * 烧录结果判定。
 *
 * UART 通常能观察到 VS Code Task 或 esp_idf_vsc_ext.log；JTAG/OpenOCD 往往只有
 * 终端输出，两者都不一定可见。因此：
 * - 有明确错误/失败标记、或 Task exitCode≠0 → 失败
 * - 有成功标记 → 成功（verified）
 * - Task exitCode=0 → 成功（task）
 * - Task 已结束但既无成功标记也无退出码 → 失败（不能当作成功）
 * - 没有 Task 且命令正常返回 → 成功（unconfirmed），由后续串口验证兜底
 */
export function classifyFlashOutcome(input: FlashOutcomeInput): FlashOutcome {
  const commandOutput = input.commandOutput ?? '';
  const logText = (input.logMessages ?? []).join('\n');
  const taskText = input.taskOutput ?? '';
  const verified =
    matchesFlashSuccess(commandOutput) ||
    matchesFlashSuccess(logText) ||
    matchesFlashSuccess(taskText);
  const failedMarker =
    matchesFlashFailure(commandOutput) ||
    matchesFlashFailure(logText) ||
    matchesFlashFailure(taskText);

  if (input.aborted) {
    return { success: false, confidence: 'unconfirmed', message: '烧录已取消' };
  }
  if (input.errors.length > 0) {
    return {
      success: false,
      confidence: 'unconfirmed',
      message: `烧录失败：${input.errors[input.errors.length - 1]}`,
    };
  }
  if (typeof input.exitCode === 'number' && input.exitCode !== 0) {
    return {
      success: false,
      confidence: 'unconfirmed',
      message: `烧录任务失败（exitCode=${input.exitCode}）`,
    };
  }
  if (failedMarker) {
    return {
      success: false,
      confidence: 'unconfirmed',
      message: '烧录失败：日志包含写入失败标记',
    };
  }

  if (verified) {
    return {
      success: true,
      confidence: 'verified',
      message: `烧录完成（${input.flashType}，日志确认 Flashed Successfully）`,
    };
  }
  if (input.taskStarted) {
    if (typeof input.exitCode === 'number') {
      return {
        success: true,
        confidence: 'task',
        message: `官方 ESP-IDF 烧录任务已完成（${input.flashType}，exitCode=0）；请通过串口验证确认设备已启动`,
      };
    }
    // 任务已结束，但没有成功标记、也没有退出码：不能当作成功。
    return {
      success: false,
      confidence: 'unconfirmed',
      message: `烧录任务已结束，但未捕获成功标记或退出码；请检查 ESP-IDF 输出面板（${input.flashType}）`,
    };
  }
  const jtag = /jtag|openocd/i.test(input.flashType);
  return {
    success: true,
    confidence: 'unconfirmed',
    message: jtag
      ? `烧录命令已完成（JTAG，官方扩展未暴露 OpenOCD 输出）；是否成功由串口验证确认`
      : `烧录命令已完成（${input.flashType}，未捕获官方日志）；交由串口验证确认`,
  };
}
