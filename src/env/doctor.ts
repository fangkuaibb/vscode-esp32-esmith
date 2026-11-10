import { IdfInfo, isVersionAtLeast } from './idfInfo';
import { isEspIdfExtensionInstalled } from './idfLocator';
import { detectTarget, isEspIdfProject } from '../core/project';
import { SerialService } from '../core/serialService';

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorStatus;
  message: string;
  remediation?: string;
}

export interface DoctorOptions {
  projectRoot?: string;
  idfInfo?: IdfInfo;
  serial: SerialService;
  mcpUrl?: string;
  officialEspIdfAvailable: boolean;
  flashType?: string;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const push = (check: DoctorCheck) => checks.push(check);

  const extensionInstalled = isEspIdfExtensionInstalled();
  push({
    id: 'esp-idf-extension',
    title: '官方 ESP-IDF 扩展',
    status: extensionInstalled ? 'pass' : 'fail',
    message: extensionInstalled
      ? '已安装 espressif.esp-idf-extension'
      : '未安装 espressif.esp-idf-extension',
    remediation: extensionInstalled
      ? undefined
      : '在扩展市场安装 ESP-IDF 扩展；ESmith 的构建、烧录和目标切换都由它执行。',
  });

  push({
    id: 'esp-idf-commands',
    title: '官方 ESP-IDF 命令',
    status: options.officialEspIdfAvailable ? 'pass' : 'fail',
    message: options.officialEspIdfAvailable
      ? 'espIdf.buildDevice / espIdf.flashUart / espIdf.setTarget 可用'
      : '官方 ESP-IDF 命令不可用',
    remediation: options.officialEspIdfAvailable
      ? undefined
      : '确认 ESP-IDF 扩展已激活，并在其欢迎页完成环境初始化。',
  });

  if (!options.projectRoot) {
    push({
      id: 'project',
      title: 'ESP-IDF 工程',
      status: 'fail',
      message: '当前没有打开工作区',
      remediation: '打开一个包含 CMakeLists.txt 的 ESP-IDF 工程。',
    });
  } else {
    const valid = isEspIdfProject(options.projectRoot);
    push({
      id: 'project',
      title: 'ESP-IDF 工程',
      status: valid ? 'pass' : 'fail',
      message: valid
        ? `工程路径：${options.projectRoot}`
        : 'CMakeLists.txt 中未找到 project.cmake / idf.cmake',
      remediation: valid ? undefined : '确认当前目录是 ESP-IDF 工程根目录。',
    });
  }

  if (!options.idfInfo) {
    push({
      id: 'idf-path',
      title: '当前 IDF',
      status: 'warn',
      message: '未读取到 idf.currentSetup',
      remediation: '在 ESP-IDF 扩展中选择当前 IDF 版本。',
    });
  } else {
    push({
      id: 'idf-path',
      title: '当前 IDF',
      status: 'pass',
      message: `${options.idfInfo.idfPath}（${options.idfInfo.source}）`,
    });
    push({
      id: 'idf-version',
      title: 'ESP-IDF 版本',
      status: isVersionAtLeast(options.idfInfo.version, '6.0.1') ? 'pass' : 'warn',
      message: `检测到 ${options.idfInfo.version}`,
      remediation: isVersionAtLeast(options.idfInfo.version, '6.0.1')
        ? undefined
        : '构建/烧录由官方扩展执行，不受影响；如果希望使用官方 idf.py mcp-server，建议切换到 6.0.1+。',
    });
    push({
      id: 'mcp-support',
      title: '官方 IDF MCP 能力',
      status: options.idfInfo.hasMcpSupport ? 'pass' : 'warn',
      message: options.idfInfo.hasMcpSupport
        ? '发现 tools/idf_py_actions/mcp_ext.py'
        : '当前 IDF 未发现官方 MCP 扩展文件',
      remediation: options.idfInfo.hasMcpSupport
        ? undefined
        : '仅影响官方 idf.py mcp-server；ESmith 自带 MCP 不受影响。',
    });
  }

  if (options.projectRoot) {
    const target = detectTarget(options.projectRoot);
    push({
      id: 'target',
      title: '目标芯片',
      status: target ? 'pass' : 'warn',
      message: target ?? '未在 sdkconfig 中检测到 CONFIG_IDF_TARGET',
      remediation: target ? undefined : '运行 ESMith: 选择目标芯片，或使用官方 ESP-IDF 的 Set Target。',
    });
  }

  push({
    id: 'serial-module',
    title: '串口模块',
    status: options.serial.isAvailable() ? 'pass' : 'fail',
    message: options.serial.isAvailable()
      ? 'serialport 原生模块加载成功'
      : options.serial.loadError ?? 'serialport 加载失败',
    remediation: options.serial.isAvailable()
      ? undefined
      : '确认扩展安装完整；如果当前平台没有预编译包，请重新安装扩展。',
  });

  if (options.serial.isAvailable()) {
    try {
      const ports = await options.serial.listPorts();
      const likely = ports.filter((port) => port.likelyEsp);
      push({
        id: 'serial-port',
        title: '串口',
        status: likely.length > 0 ? 'pass' : 'warn',
        message:
          likely.length > 0
            ? `检测到疑似 ESP 设备：${likely
                .map((port) => `${port.path}${port.isJtag ? ' (USB-JTAG)' : ''}`)
                .join(', ')}`
            : ports.length > 0
              ? `检测到串口：${ports.map((port) => port.path).join(', ')}`
              : '未检测到串口',
        remediation:
          likely.length > 0 ? undefined : '连接开发板并确认串口驱动已安装，或手动选择串口。',
      });

      const jtagPort = ports.find((port) => port.isJtag);
      if (jtagPort) {
        push({
          id: 'jtag-stability',
          title: 'USB-JTAG 稳定性',
          status: 'pass',
          message: `检测到 USB-JTAG：${jtagPort.path}。若出现 IN buffer overflow：先断电/重插，再把 esmith.flashBaudRate 降到 115200。`,
        });
      }
    } catch (error) {
      push({
        id: 'serial-port',
        title: '串口',
        status: 'warn',
        message: `串口枚举失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  push({
    id: 'flash-type',
    title: '烧录方式',
    status: 'pass',
    message: options.flashType ?? 'UART',
    remediation: undefined,
  });

  push({
    id: 'mcp-server',
    title: 'ESmith MCP Server',
    status: options.mcpUrl ? 'pass' : 'warn',
    message: options.mcpUrl ?? '未启动',
    remediation: options.mcpUrl ? undefined : '检查 esmith.mcp.enabled 设置，或查看输出面板。',
  });

  return checks;
}

export function hasDoctorFailures(checks: DoctorCheck[]): boolean {
  return checks.some((check) => check.status === 'fail');
}
