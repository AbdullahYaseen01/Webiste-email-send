/**
 * Unit-style check for daily-limit queue redistribution (no SMTP / no live store).
 * Run: node scripts/test-quota-failover.js
 */
const assert = require('assert');
const { applyPendingRedistribution } = require('../src/store');

function makeData(queue, campaigns) {
  return {
    send_queue: queue,
    campaigns: campaigns || [
      { id: 1, status: 'sending', smtp_account_id: 'account1' },
      { id: 2, status: 'sending', smtp_account_id: 'account1', campaign_type: 'follow_up' },
    ],
  };
}

function testInitialSendsMoveToHealthyInbox() {
  const data = makeData([
    { id: 1, campaign_id: 1, status: 'pending', smtp_account_id: 'account1' },
    { id: 2, campaign_id: 1, status: 'pending', smtp_account_id: 'account1' },
    { id: 3, campaign_id: 1, status: 'pending', smtp_account_id: 'account1' },
  ]);

  const result = applyPendingRedistribution(
    data,
    'account1',
    ['account2', 'account3'],
    { reason: 'Daily limit reached — moved to inbox with remaining limit' }
  );

  assert.strictEqual(result.moved, 3);
  assert.strictEqual(result.targets.account2, 2);
  assert.strictEqual(result.targets.account3, 1);
  assert.ok(data.send_queue.every(q => q.smtp_account_id !== 'account1'));
  assert.ok(data.send_queue.every(q => (q.tried_accounts || []).includes('account1')));
  console.log('✓ initial sends redistribute across healthy inboxes');
}

function testFollowUpsStayOnOriginalInbox() {
  const data = makeData([
    {
      id: 10,
      campaign_id: 2,
      status: 'pending',
      smtp_account_id: 'account1',
      is_follow_up: true,
    },
    {
      id: 11,
      campaign_id: 1,
      status: 'pending',
      smtp_account_id: 'account1',
    },
  ]);

  const result = applyPendingRedistribution(data, 'account1', ['account2']);
  assert.strictEqual(result.moved, 1);
  assert.strictEqual(data.send_queue[0].smtp_account_id, 'account1');
  assert.strictEqual(data.send_queue[1].smtp_account_id, 'account2');
  console.log('✓ follow-ups stay on the original inbox when quota is hit');
}

function testNoCandidatesLeavesQueueUntouched() {
  const data = makeData([
    { id: 1, campaign_id: 1, status: 'pending', smtp_account_id: 'account1' },
  ]);
  const result = applyPendingRedistribution(data, 'account1', []);
  assert.strictEqual(result.moved, 0);
  assert.strictEqual(data.send_queue[0].smtp_account_id, 'account1');
  console.log('✓ no healthy candidates → queue stays put');
}

function testPreferUntriedThenFallback() {
  const data = makeData([
    {
      id: 1,
      campaign_id: 1,
      status: 'pending',
      smtp_account_id: 'account1',
      tried_accounts: ['account2'],
    },
  ]);
  const result = applyPendingRedistribution(data, 'account1', ['account2', 'account3']);
  assert.strictEqual(result.moved, 1);
  assert.strictEqual(data.send_queue[0].smtp_account_id, 'account3');

  // All candidates already tried → still fall back so the day is not stuck
  const data2 = makeData([
    {
      id: 2,
      campaign_id: 1,
      status: 'pending',
      smtp_account_id: 'account1',
      tried_accounts: ['account2', 'account3'],
    },
  ]);
  const result2 = applyPendingRedistribution(data2, 'account1', ['account2', 'account3']);
  assert.strictEqual(result2.moved, 1);
  assert.ok(['account2', 'account3'].includes(data2.send_queue[0].smtp_account_id));
  console.log('✓ prefer untried inbox, then fall back to any healthy inbox');
}

function testSkipsPausedCampaignsAndNonPending() {
  const data = makeData(
    [
      { id: 1, campaign_id: 1, status: 'pending', smtp_account_id: 'account1' },
      { id: 2, campaign_id: 3, status: 'pending', smtp_account_id: 'account1' },
      { id: 3, campaign_id: 1, status: 'sent', smtp_account_id: 'account1' },
    ],
    [
      { id: 1, status: 'sending', smtp_account_id: 'account1' },
      { id: 3, status: 'paused', smtp_account_id: 'account1' },
    ]
  );
  const result = applyPendingRedistribution(data, 'account1', ['account2']);
  assert.strictEqual(result.moved, 1);
  assert.strictEqual(data.send_queue[0].smtp_account_id, 'account2');
  assert.strictEqual(data.send_queue[1].smtp_account_id, 'account1');
  console.log('✓ skips paused campaigns and non-pending rows');
}

function testClearsDeferredUntil() {
  const data = makeData([
    {
      id: 1,
      campaign_id: 1,
      status: 'pending',
      smtp_account_id: 'account1',
      deferred_until: new Date().toISOString(),
      error_message: 'Daily limit',
    },
  ]);
  applyPendingRedistribution(data, 'account1', ['account2'], { reason: 'moved' });
  assert.strictEqual(data.send_queue[0].deferred_until, null);
  assert.strictEqual(data.send_queue[0].smtp_account_id, 'account2');
  console.log('✓ clears deferred_until so next tick can send today');
}

testInitialSendsMoveToHealthyInbox();
testFollowUpsStayOnOriginalInbox();
testNoCandidatesLeavesQueueUntouched();
testPreferUntriedThenFallback();
testSkipsPausedCampaignsAndNonPending();
testClearsDeferredUntil();
console.log('\nAll quota-failover checks passed.');
