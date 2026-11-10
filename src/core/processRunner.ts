import { ChildProcess, spawn } from 'child_process';

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  output: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

export interface RunProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  maxOutputChars?: number;
}

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

class LineBuffer {
  private buffer = '';

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.buffer);
      if (!match || match.index === undefined) {
        break;
      }
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.onLine(stripAnsi(line));
    }
  }

  flush(): void {
    if (this.buffer.length > 0) {
      this.onLine(stripAnsi(this.buffer));
      this.buffer = '';
    }
  }
}

function killTree(child: ChildProcess): void {
  if (!child.pid) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    }).on('error', () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
}

function cap(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(text.length - maxChars);
}

export function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions
): Promise<ProcessResult> {
  const startedAt = Date.now();
  const maxOutputChars = options.maxOutputChars ?? 600_000;

  return new Promise<ProcessResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let combined = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const stdoutLines = new LineBuffer((line) => options.onLine?.(line, 'stdout'));
    const stderrLines = new LineBuffer((line) => options.onLine?.(line, 'stderr'));

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      stdoutLines.flush();
      stderrLines.flush();
      cleanup();
      resolve({
        code,
        signal,
        stdout: cap(stdout, maxOutputChars),
        stderr: cap(stderr, maxOutputChars),
        output: cap(combined, maxOutputChars),
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
      });
    };

    const abortHandler = () => {
      if (settled) {
        return;
      }
      aborted = true;
      killTree(child);
    };

    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener('abort', abortHandler);
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) {
          return;
        }
        timedOut = true;
        killTree(child);
      }, options.timeoutMs);
    }

    if (options.signal) {
      if (options.signal.aborted) {
        abortHandler();
      } else {
        options.signal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      combined += text;
      stdoutLines.push(text);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      combined += text;
      stderrLines.push(text);
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });

    child.on('close', (code, signal) => {
      finish(code, signal);
    });
  });
}
