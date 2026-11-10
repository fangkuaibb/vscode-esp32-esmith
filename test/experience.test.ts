import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  queryExperience,
  readStats,
  recordExperience,
  updateRunStats,
} from '../src/core/experience';

test('记录并查询经验', () => {
  const dir = mkdtempSync(join(tmpdir(), 'esmith-exp-'));
  try {
    const recorded = recordExperience(dir, {
      trigger: 'Guru Meditation Error: LoadProhibited',
      fix: '给 freertos 任务栈从 2048 提升到 4096',
      lesson: '栈溢出会表现为 LoadProhibited',
      scope: 'esp32s3',
    });
    assert.ok(recorded.id);

    const result = queryExperience(dir, 'LoadProhibited');
    assert.equal(result.total, 1);
    assert.equal(result.skills[0].id, recorded.id);

    const miss = queryExperience(dir, 'WiFi connect timeout');
    assert.equal(miss.total, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('不同项目的经验与统计完全隔离', () => {
  const projectA = mkdtempSync(join(tmpdir(), 'esmith-exp-a-'));
  const projectB = mkdtempSync(join(tmpdir(), 'esmith-exp-b-'));
  try {
    const recorded = recordExperience(projectA, {
      trigger: 'I2C timeout',
      fix: '把 SCL 上拉到 4.7k',
      lesson: 'A 项目的经验',
    });
    updateRunStats(projectA, { success: true, stage: 'verify', message: 'ok' });

    assert.match(recorded.path, /\.esmith[\\/]experience[\\/]skills/);
    assert.equal(queryExperience(projectB, 'I2C timeout').total, 0);
    assert.equal(readStats(projectB).runs, 0);

    assert.equal(queryExperience(projectA, 'I2C timeout').total, 1);
    assert.equal(readStats(projectA).runs, 1);
  } finally {
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
  }
});

test('闭环结果自动累计统计', () => {
  const dir = mkdtempSync(join(tmpdir(), 'esmith-stats-'));
  try {
    updateRunStats(dir, { success: true, stage: 'verify', message: 'ok' });
    updateRunStats(dir, { success: false, stage: 'flash', message: 'timeout' });
    const stats = readStats(dir);
    assert.equal(stats.runs, 2);
    assert.equal(stats.success, 1);
    assert.equal(stats.failure, 1);
    assert.equal(stats.stages.flash.failure, 1);
    assert.equal(stats.lastFailures.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
