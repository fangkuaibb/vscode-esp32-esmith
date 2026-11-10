import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  listServerInstances,
  registerServerInstance,
  unregisterServerInstance,
} from '../src/mcp/registry';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'esmith-registry-'));
}

test('登记实例后可按工程查询', () => {
  const dir = tempDir();
  registerServerInstance('E:/projects/demo', 37882, dir);

  const instances = listServerInstances(dir);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].projectRoot, 'E:/projects/demo');
  assert.equal(instances[0].port, 37882);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('同一工程重复登记会更新端口而不是新增文件', () => {
  const dir = tempDir();
  registerServerInstance('E:/projects/demo', 37882, dir);
  registerServerInstance('E:\\projects\\demo\\', 37901, dir);

  const instances = listServerInstances(dir);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].port, 37901);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('注销后实例消失，重复注销不抛错', () => {
  const dir = tempDir();
  registerServerInstance('E:/projects/demo', 37882, dir);
  unregisterServerInstance('E:/projects/demo', dir);
  assert.equal(listServerInstances(dir).length, 0);
  unregisterServerInstance('E:/projects/demo', dir);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('不同工程可以同时登记', () => {
  const dir = tempDir();
  registerServerInstance('E:/projects/a', 37830, dir);
  registerServerInstance('E:/projects/b', 37840, dir);

  const ports = listServerInstances(dir)
    .map((item) => item.port)
    .sort((left, right) => left - right);
  assert.deepEqual(ports, [37830, 37840]);

  fs.rmSync(dir, { recursive: true, force: true });
});
