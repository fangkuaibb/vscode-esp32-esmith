import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SelfHealingController } from '../src/core/selfHealing';

test('flash 预算用尽后终止', () => {
  const controller = new SelfHealingController({ flashRetries: 1, verifyRetries: 1 });
  assert.equal(controller.beginAttempt('flash'), 1);
  assert.equal(controller.fail('flash', 'boom').kind, 'retry');
  assert.equal(controller.beginAttempt('flash'), 2);
  assert.equal(controller.fail('flash', 'boom').kind, 'abort');
});

test('verify 预算用尽后回退到烧录锚点', () => {
  const controller = new SelfHealingController({
    flashRetries: 0,
    verifyRetries: 0,
    rewinds: 1,
  });
  assert.equal(controller.beginAttempt('verify'), 1);
  const decision = controller.fail('verify', 'no output');
  assert.equal(decision.kind, 'rewind');

  controller.rewind();
  assert.equal(controller.beginAttempt('verify'), 1);
  assert.equal(controller.fail('verify', 'still no output').kind, 'abort');
  assert.equal(controller.snapshot().rewinds.used, 1);
});

test('allowRewind=false 时 verify 失败不走重新烧录', () => {
  const controller = new SelfHealingController({
    flashRetries: 0,
    verifyRetries: 0,
    rewinds: 2,
  });
  assert.equal(controller.beginAttempt('verify'), 1);
  const decision = controller.fail('verify', 'pattern mismatch', {
    allowRewind: false,
  });
  assert.equal(decision.kind, 'abort');
  assert.equal(controller.snapshot().rewinds.used, 0);
});

test('guard limit 限制总尝试次数', () => {
  const controller = new SelfHealingController({
    flashRetries: 5,
    verifyRetries: 5,
    maxTotalAttempts: 3,
  });
  assert.equal(controller.beginAttempt('flash'), 1);
  assert.equal(controller.beginAttempt('flash'), 2);
  assert.equal(controller.beginAttempt('verify'), 1);
  assert.equal(controller.beginAttempt('flash'), undefined);
  // guard 用尽后即使是 flash 失败也必须终止，不能继续 retry。
  assert.equal(controller.fail('flash', 'boom').kind, 'abort');
});

test('build 失败不重试', () => {
  const controller = new SelfHealingController({ flashRetries: 2, verifyRetries: 2 });
  assert.equal(controller.fail('build', 'compile error').kind, 'abort');
  assert.equal(controller.snapshot().exhausted, true);
});
