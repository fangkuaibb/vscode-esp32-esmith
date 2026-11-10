import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  expectedTapIdFromEspConfig,
  findOpenOcdScriptsDirs,
  fixOpenOcdTapIds,
  parseCpuTapId,
  replaceCpuTapId,
} from '../src/core/openocdTap';

const ESP_CONFIG = JSON.stringify({
  version: '1.0',
  targets: [
    { id: 'esp32', name: 'ESP32', idcode: '0x120034e5' },
    { id: 'esp32c3', name: 'ESP32-C3', idcode: '0x00005c25' },
  ],
});

function makeScriptsTree(root: string, tapId: string): string {
  const scripts = path.join(
    root,
    'tools',
    'openocd-esp32',
    'v0.12.0-esp32-20260304',
    'openocd-esp32',
    'share',
    'openocd',
    'scripts'
  );
  fs.mkdirSync(path.join(scripts, 'target'), { recursive: true });
  fs.writeFileSync(path.join(scripts, 'esp-config.json'), ESP_CONFIG, 'utf8');
  fs.writeFileSync(
    path.join(scripts, 'target', 'esp32c3.cfg'),
    `# test config\nset _CPUTAPID                   ${tapId}\n`,
    'utf8'
  );
  return scripts;
}

test('解析与替换 _CPUTAPID', () => {
  const text = 'set _CPUTAPID                   0x120034e5\n';
  assert.equal(parseCpuTapId(text), '0x120034e5');

  const patched = replaceCpuTapId(text, '0x00005c25');
  assert.ok(patched);
  assert.equal(patched.changed, true);
  assert.equal(patched.previous, '0x120034e5');
  assert.match(patched.text, /0x00005c25/);

  const unchanged = replaceCpuTapId(patched.text, '0x00005c25');
  assert.ok(unchanged);
  assert.equal(unchanged.changed, false);
});

test('从 esp-config.json 读取目标 IDCODE', () => {
  assert.equal(expectedTapIdFromEspConfig(ESP_CONFIG, 'esp32c3'), '0x00005c25');
  assert.equal(expectedTapIdFromEspConfig(ESP_CONFIG, 'esp32'), '0x120034e5');
  assert.equal(expectedTapIdFromEspConfig(ESP_CONFIG, 'esp32c6'), undefined);
});

test('定位 openocd scripts 目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'esmith-openocd-'));
  const scripts = makeScriptsTree(root, '0x120034e5');

  const found = findOpenOcdScriptsDirs([root], 'esp32c3');
  assert.deepEqual(found, [scripts]);

  fs.rmSync(root, { recursive: true, force: true });
});

test('自动修复错误 IDCODE 并保留备份', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'esmith-openocd-'));
  const scripts = makeScriptsTree(root, '0x120034e5');
  const cfg = path.join(scripts, 'target', 'esp32c3.cfg');

  const result = fixOpenOcdTapIds({ target: 'esp32c3', roots: [root], autoFix: true });
  assert.equal(result.status, 'fixed');
  assert.match(fs.readFileSync(cfg, 'utf8'), /0x00005c25/);
  assert.equal(fs.existsSync(`${cfg}.esmith-bak`), true);

  const again = fixOpenOcdTapIds({ target: 'esp32c3', roots: [root], autoFix: true });
  assert.equal(again.status, 'ok');

  fs.rmSync(root, { recursive: true, force: true });
});

test('关闭自动修复时只报告不写文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'esmith-openocd-'));
  const scripts = makeScriptsTree(root, '0x120034e5');
  const cfg = path.join(scripts, 'target', 'esp32c3.cfg');

  const result = fixOpenOcdTapIds({ target: 'esp32c3', roots: [root], autoFix: false });
  assert.equal(result.status, 'mismatch');
  assert.match(fs.readFileSync(cfg, 'utf8'), /0x120034e5/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('找不到 scripts 目录时返回 not-found', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'esmith-openocd-'));
  const result = fixOpenOcdTapIds({ target: 'esp32c3', roots: [root], autoFix: true });
  assert.equal(result.status, 'not-found');
  fs.rmSync(root, { recursive: true, force: true });
});
