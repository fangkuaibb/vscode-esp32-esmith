import { execFile } from 'child_process';
import * as net from 'net';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const DEFAULT_OPENOCD_PORT = 3333;

export async function findListenPid(port: number): Promise<number | undefined> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp']);
      const line = stdout
        .split(/\r?\n/)
        .find(
          (item) =>
            new RegExp(`[:.]${port}\\s`).test(item) && /LISTENING/i.test(item)
        );
      const pid = line?.trim().split(/\s+/).pop();
      return pid ? Number(pid) : undefined;
    }
    const { stdout } = await execFileAsync('lsof', [
      '-ti',
      `tcp:${port}`,
      '-sTCP:LISTEN',
    ]);
    const pid = stdout.trim().split(/\s+/)[0];
    return pid ? Number(pid) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 通过 OpenOCD 的 TCL 端口发送 shutdown，让进程以 0 退出。
 * 直接 kill 会让官方扩展弹出 “OpenOCD exited with error code 1”。
 */
export async function shutdownOpenOcd(
  tclPort = 6666,
  timeoutMs = 1500
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: '127.0.0.1', port: tclPort });
    const finish = (ok: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.on('connect', () => {
      socket.write('shutdown\n');
    });
    socket.on('data', () => finish(true));
    socket.on('end', () => finish(true));
    socket.on('close', () => finish(true));
    socket.on('error', () => finish(false));
  });
}

export async function isOpenOcdProcess(pid: number): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', [
        '/FI',
        `PID eq ${pid}`,
        '/FO',
        'CSV',
        '/NH',
      ]);
      return /openocd/i.test(stdout);
    }
    const { stdout } = await execFileAsync('ps', [
      '-p',
      String(pid),
      '-o',
      'comm=',
    ]);
    return /openocd/i.test(stdout);
  } catch {
    return false;
  }
}

export async function killPid(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(pid), '/F']);
  } else {
    await execFileAsync('kill', ['-9', String(pid)]);
  }
}

export interface OpenOcdCleanupResult {
  cleaned: boolean;
  pid?: number;
  reason?: 'port-not-listening' | 'not-openocd';
}

/**
 * 结束监听指定端口的 openocd 进程。
 * 只处理进程名为 openocd 的情况，避免误杀其它占用端口的程序。
 */
export async function cleanupOpenOcd(
  port = DEFAULT_OPENOCD_PORT
): Promise<OpenOcdCleanupResult> {
  const pid = await findListenPid(port);
  if (!pid) {
    return { cleaned: false, reason: 'port-not-listening' };
  }
  if (!(await isOpenOcdProcess(pid))) {
    return { cleaned: false, pid, reason: 'not-openocd' };
  }
  await killPid(pid);
  return { cleaned: true, pid };
}

export function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
