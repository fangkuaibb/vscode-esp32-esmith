import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifyFlashOutcome } from '../src/core/flashOutcome';

test('JTAG 命令输出 Flashed Successfully 时判定成功', () => {
  const outcome = classifyFlashOutcome({
    flashType: 'JTAG',
    aborted: false,
    errors: [],
    commandOutput: '** Flashed Successfully (JTAG) **',
  });
  assert.equal(outcome.success, true);
  assert.equal(outcome.confidence, 'verified');
});

test('[/Flash] 完成标记也视为烧录成功', () => {
  const outcome = classifyFlashOutcome({
    flashType: 'JTAG',
    aborted: false,
    errors: [],
    logMessages: ['[OpenOCD] [/Flash]'],
  });
  assert.equal(outcome.success, true);
  assert.equal(outcome.confidence, 'verified');
});

test('无任务、无日志、无错误时交由串口验证兜底', () => {
  const outcome = classifyFlashOutcome({
    flashType: 'JTAG',
    aborted: false,
    errors: [],
  });
  assert.equal(outcome.success, true);
  assert.equal(outcome.confidence, 'unconfirmed');
});

test('任务 exitCode=0 且无成功标记时判定为 task', () => {
  const outcome = classifyFlashOutcome({
    flashType: 'UART',
    aborted: false,
    errors: [],
    taskStarted: true,
    exitCode: 0,
  });
  assert.equal(outcome.success, true);
  assert.equal(outcome.confidence, 'task');
});

test('任务 exitCode≠0 判定失败', () => {
  const outcome = classifyFlashOutcome({
    flashType: 'UART',
    aborted: false,
    errors: [],
    taskStarted: true,
    exitCode: 1,
  });
  assert.equal(outcome.success, false);
  assert.match(outcome.message, /exitCode=1/);
});

test('Task 输出包含 Flash task failed 判定失败', () => {
  const outcome = classifyFlashOutcome({
    flashType: 'UART',
    aborted: false,
    errors: [],
    taskStarted: true,
    taskOutput: 'Flash task failed. Check the terminal output for details.',
  });
  assert.equal(outcome.success, false);
  assert.match(outcome.message, /失败/);
});

test('任务结束但无退出码和成功标记时不判定成功', () => {
  const outcome = classifyFlashOutcome({
    flashType: 'UART',
    aborted: false,
    errors: [],
    taskStarted: true,
  });
  assert.equal(outcome.success, false);
  assert.equal(outcome.confidence, 'unconfirmed');
});

test('官方错误优先判定失败', () => {
  const outcome = classifyFlashOutcome({
    flashType: 'UART',
    aborted: false,
    errors: ['Failed to connect to ESP32'],
    taskStarted: true,
  });
  assert.equal(outcome.success, false);
  assert.match(outcome.message, /烧录失败/);
});

test('日志失败标记判定失败', () => {
  const outcome = classifyFlashOutcome({
    flashType: 'JTAG',
    aborted: false,
    errors: [],
    commandOutput: 'Error: Failed to flash the target',
  });
  assert.equal(outcome.success, false);
});

test('取消优先判定失败', () => {
  const outcome = classifyFlashOutcome({
    flashType: 'JTAG',
    aborted: true,
    errors: [],
    commandOutput: 'Flashed Successfully (JTAG)',
  });
  assert.equal(outcome.success, false);
  assert.equal(outcome.message, '烧录已取消');
});
