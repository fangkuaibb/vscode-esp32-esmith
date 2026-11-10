import * as fs from 'fs';
import * as path from 'path';

export function readTextFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

export function isEspIdfProject(projectRoot: string): boolean {
  const cmakeLists = readTextFile(path.join(projectRoot, 'CMakeLists.txt'));
  if (!cmakeLists) {
    return false;
  }
  return (
    cmakeLists.includes('project.cmake') ||
    cmakeLists.includes('idf.cmake') ||
    cmakeLists.includes('idf_component_register')
  );
}

export function detectTarget(projectRoot: string): string | undefined {
  const sdkconfig = readTextFile(path.join(projectRoot, 'sdkconfig'));
  if (sdkconfig) {
    const match = /^CONFIG_IDF_TARGET="([^"]+)"/m.exec(sdkconfig);
    if (match) {
      return match[1];
    }
  }

  const defaults = readTextFile(path.join(projectRoot, 'sdkconfig.defaults'));
  if (defaults) {
    const match = /^CONFIG_IDF_TARGET="([^"]+)"/m.exec(defaults);
    if (match) {
      return match[1];
    }
  }

  try {
    const description = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'build', 'project_description.json'), 'utf8')
    ) as { target?: string };
    if (description.target) {
      return description.target;
    }
  } catch {
    // ignore
  }

  return undefined;
}

export function detectProjectName(projectRoot: string): string {
  const cmakeLists = readTextFile(path.join(projectRoot, 'CMakeLists.txt'));
  if (cmakeLists) {
    const match = /project\s*\(\s*([A-Za-z0-9_.-]+)/.exec(cmakeLists);
    if (match) {
      return match[1];
    }
  }
  return path.basename(projectRoot);
}

export function getArtifacts(projectRoot: string, buildDir: string): {
  elf?: string;
  bin?: string;
  flasherArgs?: string;
} {
  const name = detectProjectName(projectRoot);
  const buildRoot = path.isAbsolute(buildDir) ? buildDir : path.resolve(projectRoot, buildDir);
  const candidates = {
    elf: path.join(buildRoot, `${name}.elf`),
    bin: path.join(buildRoot, `${name}.bin`),
    flasherArgs: path.join(buildRoot, 'flasher_args.json'),
  };
  return {
    elf: fs.existsSync(candidates.elf) ? candidates.elf : undefined,
    bin: fs.existsSync(candidates.bin) ? candidates.bin : undefined,
    flasherArgs: fs.existsSync(candidates.flasherArgs) ? candidates.flasherArgs : undefined,
  };
}
