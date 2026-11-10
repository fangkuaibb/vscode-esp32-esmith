import { LogLine } from './ringBuffer';

const CRASH_PATTERNS: string[] = [
  'Guru Meditation Error',
  'abort() was called',
  'assert failed:',
  'PANIC',
  'Backtrace:',
  'Rebooting...',
  'LoadProhibited',
  'StoreProhibited',
  'IllegalInstruction',
  'DivideByZero',
  'Stack canary watchpoint triggered',
  'Brownout',
  'Core  0 register dump',
  'Core  1 register dump',
  'Task watchdog got triggered',
  'Interrupt wdt timeout',
  'Stack overflow',
  'esp_backtrace_print',
];

export interface CrashInfo {
  signature: string;
  patterns: string[];
  context: LogLine[];
  occurredAt: number;
}

export function detectCrash(line: string): string[] {
  const found: string[] = [];
  for (const pattern of CRASH_PATTERNS) {
    if (line.includes(pattern)) {
      found.push(pattern);
    }
  }
  return found;
}

export function detectCrashInText(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    for (const pattern of detectCrash(line)) {
      found.add(pattern);
    }
  }
  return Array.from(found);
}

export function createCrashInfo(patterns: string[], context: LogLine[]): CrashInfo {
  const unique = Array.from(new Set(patterns));
  return {
    signature: unique.join(', '),
    patterns: unique,
    context: context.slice(-300),
    occurredAt: Date.now(),
  };
}

export function crashToText(crash: CrashInfo): string {
  return [
    `崩溃签名: ${crash.signature}`,
    '--- 崩溃前日志 ---',
    ...crash.context.map((line) => line.text),
  ].join('\n');
}
