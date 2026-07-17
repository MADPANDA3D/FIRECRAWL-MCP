import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { PreviewLedger } from '../src/ledger.js';
import { makeHarness } from './helpers.js';

const binding = (overrides = {}) => ({
  userHash: '1'.repeat(64),
  keyHash: '2'.repeat(64),
  tool: 'firecrawl_map_public_site',
  argsHash: 'a'.repeat(64),
  dnsHash: 'd'.repeat(64),
  buildSha: 'b'.repeat(40),
  sourceFingerprint: '5'.repeat(64),
  descriptorHash: '6'.repeat(64),
  operationBudget: 25,
  dailyBudget: 50,
  ...overrides,
});

test('ledger stores only hashes, reserves atomically, settles, and rejects token reuse', async () => {
  const { ledger, config } = await makeHarness();
  const issued = await ledger.issue({ binding: binding(), cost: 1, ttlSeconds: 300 });
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/u);
  const serialized = await readFile(config.ledgerPath, 'utf8');
  assert.ok(!serialized.includes(issued.token));
  assert.equal((await stat(config.ledgerPath)).mode & 0o777, 0o600);
  const consumed = await ledger.consume({ token: issued.token, binding: binding(), cost: 1 });
  assert.equal((await ledger.statusForUser('1'.repeat(64), '2'.repeat(64))).daily_reserved, 1);
  await ledger.settle(consumed.tokenHash, 'spent');
  const status = await ledger.statusForUser('1'.repeat(64), '2'.repeat(64));
  assert.equal(status.daily_reserved, 0);
  assert.equal(status.daily_spent, 1);
  await assert.rejects(() => ledger.consume({ token: issued.token, binding: binding(), cost: 1 }), /already been consumed/iu);
});

test('ledger binds every security field and projected cost', async () => {
  const fields = [
    'userHash', 'keyHash', 'tool', 'argsHash', 'dnsHash', 'buildSha',
    'sourceFingerprint', 'descriptorHash', 'operationBudget', 'dailyBudget',
  ];
  for (const field of fields) {
    const { ledger } = await makeHarness();
    const original = binding();
    const issued = await ledger.issue({ binding: original, cost: 2, ttlSeconds: 300 });
    await assert.rejects(
      () => ledger.consume({ token: issued.token, binding: { ...original, [field]: original[field] + 'x' }, cost: 2 }),
      /does not match/iu,
      field,
    );
  }
  const { ledger } = await makeHarness();
  const issued = await ledger.issue({ binding: binding(), cost: 2, ttlSeconds: 300 });
  await assert.rejects(() => ledger.consume({ token: issued.token, binding: binding(), cost: 3 }), /does not match/iu);
});

test('expired tokens fail, daily limits are atomic, and in-flight is one per key', async () => {
  let now = Date.parse('2026-07-14T12:00:00Z');
  const { ledger } = await makeHarness({ now: () => now });
  const expired = await ledger.issue({ binding: binding(), cost: 1, ttlSeconds: 300 });
  now += 300001;
  await assert.rejects(() => ledger.consume({ token: expired.token, binding: binding(), cost: 1 }), /expired/iu);

  const low = binding({ dailyBudget: 2 });
  const first = await ledger.issue({ binding: low, cost: 2, ttlSeconds: 300 });
  await ledger.consume({ token: first.token, binding: low, cost: 2 });
  await assert.rejects(() => ledger.issue({ binding: low, cost: 1, ttlSeconds: 300 }), /daily/iu);

  const otherUser = binding({ userHash: '7'.repeat(64), argsHash: '8'.repeat(64) });
  const second = await ledger.issue({ binding: otherUser, cost: 1, ttlSeconds: 300 });
  await assert.rejects(() => ledger.consume({ token: second.token, binding: otherUser, cost: 1 }), /in flight/iu);
});

test('startup conservatively converts active crash residue into spent indeterminate outcome', async () => {
  const { ledger, config } = await makeHarness();
  const issued = await ledger.issue({ binding: binding(), cost: 3, ttlSeconds: 300 });
  await ledger.consume({ token: issued.token, binding: binding(), cost: 3 });
  const restarted = await new PreviewLedger({ path: config.ledgerPath, maxInFlight: 1 }).init();
  const status = await restarted.statusForUser('1'.repeat(64), '2'.repeat(64));
  assert.equal(status.daily_reserved, 0);
  assert.equal(status.daily_spent, 3);
  assert.equal(status.active_paid_requests, 0);
});

test('old settled tokens are pruned and corrupt ledgers fail closed', async () => {
  let now = Date.parse('2026-07-14T12:00:00Z');
  const { ledger, config } = await makeHarness({ now: () => now });
  const issued = await ledger.issue({ binding: binding(), cost: 1, ttlSeconds: 300 });
  const consumed = await ledger.consume({ token: issued.token, binding: binding(), cost: 1 });
  await ledger.settle(consumed.tokenHash);
  now += 49 * 60 * 60 * 1000;
  await ledger.issue({ binding: binding({ argsHash: '9'.repeat(64) }), cost: 1, ttlSeconds: 300 });
  assert.equal(Object.values(ledger.state.tokens).filter(({ status }) => status === 'spent').length, 0);
  await writeFile(config.ledgerPath, '{broken', 'utf8');
  await assert.rejects(() => new PreviewLedger({ path: config.ledgerPath }).init(), /valid bounded v1 ledger/iu);
});

test('structured ledger corruption and accounting-link tampering fail closed', async () => {
  const cases = [
    ['tokens array', 'issued', (state) => { state.tokens = []; }],
    ['daily null', 'issued', (state) => { state.daily = null; }],
    ['active array', 'issued', (state) => { state.active = []; }],
    ['extra root field', 'issued', (state) => { state.extra = true; }],
    ['malformed token hash', 'issued', (state) => {
      const [key, value] = Object.entries(state.tokens)[0];
      delete state.tokens[key];
      state.tokens.bad = value;
    }],
    ['negative counter', 'issued', (state) => { Object.values(state.daily)[0].spent = -1; }],
    ['string counter', 'issued', (state) => { Object.values(state.daily)[0].reserved = '0'; }],
    ['consumed without active', 'consumed', (state) => { state.active = {}; }],
    ['active link mismatch', 'consumed', (state) => { Object.values(state.active)[0].userHash = 'f'.repeat(64); }],
    ['active without daily', 'consumed', (state) => { state.daily = {}; }],
    ['spent below retained outcomes', 'spent', (state) => { Object.values(state.daily)[0].spent = 0; }],
    ['settled token with unknown field', 'spent', (state) => { Object.values(state.tokens)[0].unknown = true; }],
  ];
  for (const [label, stage, mutate] of cases) {
    const { ledger, config } = await makeHarness();
    const issued = await ledger.issue({ binding: binding(), cost: 1, ttlSeconds: 300 });
    if (stage !== 'issued') {
      const consumed = await ledger.consume({ token: issued.token, binding: binding(), cost: 1 });
      if (stage === 'spent') await ledger.settle(consumed.tokenHash, 'spent', 1);
    }
    const state = JSON.parse(await readFile(config.ledgerPath, 'utf8'));
    mutate(state);
    await writeFile(config.ledgerPath, JSON.stringify(state), 'utf8');
    await assert.rejects(
      () => new PreviewLedger({ path: config.ledgerPath }).init(),
      /valid bounded v1 ledger/iu,
      label,
    );
  }
});

test('live preview, record, byte, and persisted-state caps are enforced', async () => {
  const newLedger = async (options) => {
    const { config } = await makeHarness();
    return new PreviewLedger({ path: config.ledgerPath + '.cap', maxInFlight: 1, ...options }).init();
  };

  const perUser = await newLedger({ maxLivePerUser: 1 });
  await perUser.issue({ binding: binding(), cost: 1, ttlSeconds: 300 });
  await assert.rejects(
    () => perUser.issue({ binding: binding({ keyHash: '7'.repeat(64), argsHash: '8'.repeat(64) }), cost: 1, ttlSeconds: 300 }),
    (error) => error.code === 'preview_user_limit',
  );

  const perKey = await newLedger({ maxLivePerKey: 1 });
  await perKey.issue({ binding: binding(), cost: 1, ttlSeconds: 300 });
  await assert.rejects(
    () => perKey.issue({ binding: binding({ userHash: '7'.repeat(64), argsHash: '8'.repeat(64) }), cost: 1, ttlSeconds: 300 }),
    (error) => error.code === 'preview_key_limit',
  );

  const global = await newLedger({ maxLiveGlobal: 2 });
  await global.issue({ binding: binding(), cost: 1, ttlSeconds: 300 });
  await global.issue({ binding: binding({ userHash: '7'.repeat(64), keyHash: '8'.repeat(64), argsHash: '9'.repeat(64) }), cost: 1, ttlSeconds: 300 });
  await assert.rejects(
    () => global.issue({ binding: binding({ userHash: 'a'.repeat(64), keyHash: 'c'.repeat(64), argsHash: 'e'.repeat(64) }), cost: 1, ttlSeconds: 300 }),
    (error) => error.code === 'preview_global_limit',
  );

  const records = await newLedger({ maxRecords: 1 });
  await records.issue({ binding: binding(), cost: 1, ttlSeconds: 300 });
  await assert.rejects(
    () => records.issue({ binding: binding({ argsHash: '7'.repeat(64) }), cost: 1, ttlSeconds: 300 }),
    (error) => error.code === 'preview_storage_limit',
  );

  const bytes = await newLedger({ maxBytes: 300 });
  await assert.rejects(
    () => bytes.issue({ binding: binding(), cost: 1, ttlSeconds: 300 }),
    (error) => error.code === 'preview_storage_limit',
  );

  const persisted = await newLedger({ maxRecords: 2 });
  await persisted.issue({ binding: binding(), cost: 1, ttlSeconds: 300 });
  await persisted.issue({ binding: binding({ userHash: '7'.repeat(64), keyHash: '8'.repeat(64), argsHash: '9'.repeat(64) }), cost: 1, ttlSeconds: 300 });
  await assert.rejects(
    () => new PreviewLedger({ path: persisted.path, maxRecords: 1 }).init(),
    /valid bounded v1 ledger/iu,
  );
});

test('expired issued previews are pruned before enforcing live capacity', async () => {
  let now = Date.parse('2026-07-14T12:00:00Z');
  const { config } = await makeHarness();
  const ledger = await new PreviewLedger({
    path: config.ledgerPath + '.expiry',
    now: () => now,
    maxLiveGlobal: 1,
  }).init();
  await ledger.issue({ binding: binding(), cost: 1, ttlSeconds: 300 });
  now += 300001;
  const replacement = await ledger.issue({ binding: binding({ argsHash: '7'.repeat(64) }), cost: 1, ttlSeconds: 300 });
  assert.match(replacement.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(Object.keys(ledger.state.tokens).length, 1);
});
