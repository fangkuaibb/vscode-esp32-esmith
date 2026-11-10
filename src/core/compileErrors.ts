import { stripAnsi } from './processRunner';

export interface CompileDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  raw: string;
}

const GCC_RE = /^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.+)$/i;
const CMAKE_RE = /^CMake\s+(Error|Warning)\s+at\s+(.+?):(\d+)(?:\s*\(([^)]*)\))?\s*:?\s*(.*)$/i;

function severityOf(kind: string): CompileDiagnostic['severity'] {
  const lower = kind.toLowerCase();
  if (lower.includes('warning')) {
    return 'warning';
  }
  if (lower === 'note') {
    return 'info';
  }
  return 'error';
}

function pushUnique(target: CompileDiagnostic[], item: CompileDiagnostic): void {
  const key = diagnosticKey(item);
  if (!target.some((existing) => diagnosticKey(existing) === key)) {
    target.push(item);
  }
}

/**
 * 同一处诊断可能来自语言服务器和 Task 输出，路径的大小写/分隔符还不一致。
 * 去重时统一成小写 + 正斜杠，且比较 file+line+message。
 */
function diagnosticKey(item: CompileDiagnostic): string {
  return [
    item.file.replace(/\\/g, '/').trim().toLowerCase(),
    item.line,
    item.message.trim(),
  ].join('|');
}

export function mergeDiagnostics(
  base: CompileDiagnostic[],
  extra: CompileDiagnostic[]
): CompileDiagnostic[] {
  const result: CompileDiagnostic[] = [];
  const seen = new Set<string>();
  for (const item of [...base, ...extra]) {
    const key = diagnosticKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

/**
 * 解析 GCC/Clang、CMake、Ninja 与链接器输出，尽量给出可点击的 file:line:column。
 */
export function parseCompileErrors(output: string): CompileDiagnostic[] {
  const text = stripAnsi(output);
  const lines = text.split(/\r?\n/);
  const diagnostics: CompileDiagnostic[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }

    const gcc = GCC_RE.exec(line);
    if (gcc) {
      pushUnique(diagnostics, {
        file: gcc[1].trim(),
        line: Number.parseInt(gcc[2], 10) || 0,
        column: gcc[3] ? Number.parseInt(gcc[3], 10) || 0 : 0,
        severity: severityOf(gcc[4]),
        message: gcc[5].trim(),
        raw: line,
      });
      continue;
    }

    const cmake = CMAKE_RE.exec(line);
    if (cmake) {
      const collected: string[] = [];
      if (cmake[5]?.trim()) {
        collected.push(cmake[5].trim());
      }
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const next = lines[cursor];
        const trimmed = next.trim();
        if (!trimmed) {
          if (collected.length > 0) {
            break;
          }
          continue;
        }
        if (CMAKE_RE.test(trimmed) || GCC_RE.test(trimmed) || trimmed.startsWith('Call Stack')) {
          break;
        }
        collected.push(trimmed);
        if (collected.length >= 8) {
          break;
        }
      }
      pushUnique(diagnostics, {
        file: cmake[2].trim(),
        line: Number.parseInt(cmake[3], 10) || 0,
        column: 0,
        severity: severityOf(cmake[1]),
        message: collected.join('\n') || line,
        raw: line,
      });
      continue;
    }

    const lower = line.toLowerCase();
    if (
      lower.includes('undefined reference to') ||
      lower.includes('multiple definition of') ||
      lower.includes('ld returned') ||
      lower.startsWith('ninja: build stopped') ||
      lower.startsWith('failed:')
    ) {
      pushUnique(diagnostics, {
        file: '',
        line: 0,
        column: 0,
        severity: 'error',
        message: line.trim().slice(0, 1200),
        raw: line,
      });
    }
  }

  if (!diagnostics.some((item) => item.severity === 'error')) {
    const fallback: CompileDiagnostic[] = [];
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (
        (lower.includes('error:') || lower.includes('fatal error')) &&
        !lower.includes('without error') &&
        !lower.includes('no error') &&
        !lower.includes('permission denied') &&
        !lower.includes('no such file or directory')
      ) {
        pushUnique(fallback, {
          file: '',
          line: 0,
          column: 0,
          severity: 'error',
          message: stripAnsi(line).trim().slice(0, 1200),
          raw: line,
        });
        if (fallback.length >= 20) {
          break;
        }
      }
    }
    diagnostics.push(...fallback);
  }

  return diagnostics;
}
