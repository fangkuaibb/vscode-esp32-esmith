import { execFile } from 'child_process';
import { promisify } from 'util';
import { listSerialPorts } from './serialService';

const execFileAsync = promisify(execFile);

export interface UsbJtagLocation {
  port: string;
  /** OpenOCD 的 adapter usb location，格式 bus-port[.port]。 */
  location: string;
  usbSerial?: string;
}

/**
 * 只接受 bus-port 形式，避免把 Windows 的 PnP locationId 误当成 OpenOCD 位置。
 */
export function normalizeUsbLocation(value: string | undefined): string | undefined {
  const text = String(value ?? '').trim();
  return /^\d+-[0-9]+(?:\.[0-9]+)*$/.test(text) ? text : undefined;
}

/**
 * 把官方 ESP-IDF 插件选中的 COM 口解析成 OpenOCD 的 USB 位置。
 * 这样 OpenOCD 会打开用户选中的那块板，而不是按枚举顺序抓第一块。
 */
export async function resolveUsbJtagLocation(
  portPath: string
): Promise<UsbJtagLocation | undefined> {
  const target = String(portPath ?? '').trim();
  if (!target) {
    return undefined;
  }

  let ports;
  try {
    ports = await listSerialPorts();
  } catch {
    return undefined;
  }
  const info = ports.find(
    (item) => item.path.toLowerCase() === target.toLowerCase()
  );
  if (!info) {
    return undefined;
  }

  const vendorId = String(info.vendorId ?? '').toLowerCase();
  const productId = String(info.productId ?? '').toLowerCase();

  if (process.platform === 'win32' && vendorId === '303a' && productId === '1001') {
    const resolved = await queryWindowsUsbLocation(target);
    if (resolved) {
      return { port: target, location: resolved.location, usbSerial: resolved.usbSerial };
    }
  }

  const fallback = normalizeUsbLocation(info.locationId);
  return fallback
    ? { port: target, location: fallback, usbSerial: info.serialNumber }
    : undefined;
}

async function queryWindowsUsbLocation(
  portPath: string
): Promise<{ location: string; usbSerial?: string } | undefined> {
  // COM 名只允许字母数字，避免拼接 PowerShell 时注入。
  if (!/^[A-Za-z0-9]+$/.test(portPath)) {
    return undefined;
  }
  const script = `
$ErrorActionPreference='Stop'
$port='${portPath}'
$dev = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
  Where-Object { $_.FriendlyName -like "*($port)*" -and $_.InstanceId -like 'USB\\VID_303A&PID_1001*' } |
  Select-Object -First 1
if (-not $dev) { return }
$parent = (Get-PnpDeviceProperty -InstanceId $dev.InstanceId -KeyName 'DEVPKEY_Device_Parent').Data
if (-not $parent) { return }
$bus = (Get-PnpDeviceProperty -InstanceId $parent -KeyName 'DEVPKEY_Device_BusNumber').Data
$addr = (Get-PnpDeviceProperty -InstanceId $parent -KeyName 'DEVPKEY_Device_Address').Data
if ($null -eq $addr) { return }
$usbSerial = $parent.Substring($parent.LastIndexOf('\\') + 1)
Write-Output ("{0}-{1}|{2}" -f ([int]$bus + 1), $addr, $usbSerial)
`;
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 5000, windowsHide: true }
    );
    const line = stdout.trim().split(/\r?\n/).pop() ?? '';
    const [location, usbSerial] = line.split('|');
    const normalized = normalizeUsbLocation(location);
    return normalized ? { location: normalized, usbSerial: usbSerial || undefined } : undefined;
  } catch {
    return undefined;
  }
}
