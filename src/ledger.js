import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ServiceError } from './errors.js';
import { isPlainObject, sha256 } from './util.js';

export const MAX_LIVE_PREVIEWS_PER_USER = 20;
export const MAX_LIVE_PREVIEWS_PER_KEY = 20;
export const MAX_LIVE_PREVIEWS_GLOBAL = 200;
export const MAX_PREVIEW_RECORDS = 500;
export const MAX_LEDGER_BYTES = 524288;

const PAID_TOOLS = new Set([
  'firecrawl_scrape_public_page',
  'firecrawl_search_public_web',
  'firecrawl_map_public_site',
]);
const TOKEN_STATUSES = new Set(['issued', 'expired', 'consumed', 'spent', 'indeterminate']);
const HASH_64 = /^[a-f0-9]{64}$/u;
const BUILD_SHA = /^(?:development|[a-f0-9]{40})$/u;
const SOURCE_FINGERPRINT = /^(?:development|[a-f0-9]{64})$/u;
const DAY_KEY = /^([0-9]{4}-[0-9]{2}-[0-9]{2}):([a-f0-9]{64})$/u;

const emptyState = () => ({ version: 1, tokens: {}, daily: {}, active: {} });
const utcDay = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);
const safeInteger = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => (
  Number.isSafeInteger(value) && value >= minimum && value <= maximum
);
const hasExactKeys = (value, expected) => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};

const TOKEN_BASE_KEYS = Object.freeze([
  'userHash', 'keyHash', 'tool', 'argsHash', 'dnsHash', 'buildSha',
  'sourceFingerprint', 'descriptorHash', 'operationBudget', 'dailyBudget',
  'cost', 'created_at', 'expires_at', 'status',
]);

const validTokenRecord = (record) => {
  if (!isPlainObject(record)) return false;
  const statusKeys = record.status === 'consumed'
    ? [...TOKEN_BASE_KEYS, 'consumed_at']
    : ['spent', 'indeterminate'].includes(record.status)
      ? [...TOKEN_BASE_KEYS, 'consumed_at', 'actual_cost', 'settled_at']
      : TOKEN_BASE_KEYS;
  if (!hasExactKeys(record, statusKeys)) return false;
  const stringsValid = (
    HASH_64.test(record.userHash)
    && HASH_64.test(record.keyHash)
    && PAID_TOOLS.has(record.tool)
    && HASH_64.test(record.argsHash)
    && HASH_64.test(record.dnsHash)
    && BUILD_SHA.test(record.buildSha)
    && SOURCE_FINGERPRINT.test(record.sourceFingerprint)
    && HASH_64.test(record.descriptorHash)
    && TOKEN_STATUSES.has(record.status)
  );
  if (!stringsValid) return false;
  if (!safeInteger(record.operationBudget, 1, 25) || !safeInteger(record.dailyBudget, 1, 50)) return false;
  if (!safeInteger(record.cost, 1, 25) || record.cost > record.operationBudget) return false;
  if (!safeInteger(record.created_at, 1) || !safeInteger(record.expires_at, 1) || record.expires_at <= record.created_at) return false;
  if (record.expires_at - record.created_at > 300000) return false;
  if (['consumed', 'spent', 'indeterminate'].includes(record.status)) {
    if (!safeInteger(record.consumed_at, record.created_at, record.expires_at - 1)) return false;
  }
  if (['spent', 'indeterminate'].includes(record.status)) {
    if (!safeInteger(record.actual_cost, 0)) return false;
    if (!safeInteger(record.settled_at, record.consumed_at)) return false;
  }
  return true;
};

const validateState = (state, limits) => {
  if (
    !isPlainObject(state)
    || state.version !== 1
    || !isPlainObject(state.tokens)
    || !isPlainObject(state.daily)
    || !isPlainObject(state.active)
    || !hasExactKeys(state, ['version', 'tokens', 'daily', 'active'])
  ) throw new Error('invalid ledger structure');

  const tokenEntries = Object.entries(state.tokens);
  if (tokenEntries.length > limits.maxRecords) throw new Error('ledger record cap exceeded');
  const issued = [];
  for (const [tokenHash, record] of tokenEntries) {
    if (!HASH_64.test(tokenHash) || !validTokenRecord(record)) throw new Error('invalid token record');
    if (record.status === 'issued') issued.push(record);
  }
  if (issued.length > limits.maxLiveGlobal) throw new Error('live preview global cap exceeded');
  const liveUsers = new Map();
  const liveKeys = new Map();
  for (const record of issued) {
    liveUsers.set(record.userHash, (liveUsers.get(record.userHash) || 0) + 1);
    liveKeys.set(record.keyHash, (liveKeys.get(record.keyHash) || 0) + 1);
  }
  if ([...liveUsers.values()].some((count) => count > limits.maxLivePerUser)) throw new Error('live preview user cap exceeded');
  if ([...liveKeys.values()].some((count) => count > limits.maxLivePerKey)) throw new Error('live preview key cap exceeded');

  for (const [dayKey, record] of Object.entries(state.daily)) {
    if (!DAY_KEY.test(dayKey) || !isPlainObject(record) || !hasExactKeys(record, ['spent', 'reserved'])) {
      throw new Error('invalid daily record');
    }
    const parsedDay = Date.parse(dayKey.slice(0, 10) + 'T00:00:00.000Z');
    if (!Number.isFinite(parsedDay) || new Date(parsedDay).toISOString().slice(0, 10) !== dayKey.slice(0, 10)) {
      throw new Error('invalid daily record');
    }
    if (!safeInteger(record.spent) || !safeInteger(record.reserved)) throw new Error('invalid daily counters');
  }

  const activeByKey = {};
  const reservedByDay = {};
  const knownSpentByDay = {};
  for (const [tokenHash, active] of Object.entries(state.active)) {
    const token = state.tokens[tokenHash];
    if (
      !HASH_64.test(tokenHash)
      || !isPlainObject(active)
      || !hasExactKeys(active, ['userHash', 'keyHash', 'tool', 'started_at'])
      || !token
      || token.status !== 'consumed'
      || active.userHash !== token.userHash
      || active.keyHash !== token.keyHash
      || active.tool !== token.tool
      || !safeInteger(active.started_at, 1)
    ) throw new Error('invalid active record');
    activeByKey[active.keyHash] = (activeByKey[active.keyHash] || 0) + 1;
    if (activeByKey[active.keyHash] > limits.maxInFlight) throw new Error('active per-key cap exceeded');
    const dayKey = utcDay(token.consumed_at) + ':' + token.userHash;
    reservedByDay[dayKey] = (reservedByDay[dayKey] || 0) + token.cost;
  }
  for (const [tokenHash, token] of tokenEntries) {
    if (token.status === 'consumed' && !state.active[tokenHash]) throw new Error('consumed token is not active');
    if (['spent', 'indeterminate'].includes(token.status)) {
      const dayKey = utcDay(token.consumed_at) + ':' + token.userHash;
      const known = (knownSpentByDay[dayKey] || 0) + token.actual_cost;
      if (!safeInteger(known)) throw new Error('known spent counter overflow');
      knownSpentByDay[dayKey] = known;
    }
  }
  for (const [dayKey, reserved] of Object.entries(reservedByDay)) {
    if (!state.daily[dayKey] || state.daily[dayKey].reserved !== reserved) {
      throw new Error('active token daily record mismatch');
    }
  }
  for (const [dayKey, knownSpent] of Object.entries(knownSpentByDay)) {
    if (!state.daily[dayKey] || state.daily[dayKey].spent < knownSpent) {
      throw new Error('settled token daily record mismatch');
    }
  }
  for (const [dayKey, daily] of Object.entries(state.daily)) {
    if (daily.reserved !== (reservedByDay[dayKey] || 0)) throw new Error('daily reserved counter mismatch');
  }
};

export class PreviewLedger {
  constructor({
    path,
    maxInFlight = 1,
    now = Date.now,
    maxLivePerUser = MAX_LIVE_PREVIEWS_PER_USER,
    maxLivePerKey = MAX_LIVE_PREVIEWS_PER_KEY,
    maxLiveGlobal = MAX_LIVE_PREVIEWS_GLOBAL,
    maxRecords = MAX_PREVIEW_RECORDS,
    maxBytes = MAX_LEDGER_BYTES,
  }) {
    this.path = path;
    this.maxInFlight = maxInFlight;
    this.now = now;
    this.maxLivePerUser = maxLivePerUser;
    this.maxLivePerKey = maxLivePerKey;
    this.maxLiveGlobal = maxLiveGlobal;
    this.maxRecords = maxRecords;
    this.maxBytes = maxBytes;
    this.state = emptyState();
    this.tail = Promise.resolve();
  }

  limits() {
    return {
      maxInFlight: this.maxInFlight,
      maxLivePerUser: this.maxLivePerUser,
      maxLivePerKey: this.maxLivePerKey,
      maxLiveGlobal: this.maxLiveGlobal,
      maxRecords: this.maxRecords,
    };
  }

  async init() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      const serialized = await readFile(this.path, 'utf8');
      if (Buffer.byteLength(serialized, 'utf8') > this.maxBytes) throw new Error('ledger byte cap exceeded');
      const parsed = JSON.parse(serialized);
      validateState(parsed, this.limits());
      this.state = parsed;
      await this.recoverIndeterminate();
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('FIRECRAWL_LEDGER_PATH does not contain a valid bounded v1 ledger');
      await this.persist();
    }
    await chmod(this.path, 0o600);
    return this;
  }

  async persist() {
    validateState(this.state, this.limits());
    const serialized = JSON.stringify(this.state) + '\n';
    if (Buffer.byteLength(serialized, 'utf8') > this.maxBytes) {
      throw new ServiceError('preview_storage_limit', 'The bounded preview ledger reached its byte limit.', { statusCode: 503 });
    }
    const temporary = this.path + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp';
    let renamed = false;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(serialized, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
      renamed = true;
      await chmod(this.path, 0o600);
      const directory = await open(dirname(this.path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      if (!renamed) await unlink(temporary).catch(() => {});
    }
  }

  runExclusive(operation) {
    const run = this.tail.then(operation, operation);
    this.tail = run.catch(() => {});
    return run;
  }

  dailyKey(userHash, timestamp = this.now()) {
    return utcDay(timestamp) + ':' + userHash;
  }

  dailyRecord(userHash, timestamp = this.now()) {
    const key = this.dailyKey(userHash, timestamp);
    if (!this.state.daily[key]) this.state.daily[key] = { spent: 0, reserved: 0 };
    return this.state.daily[key];
  }

  cleanup(timestamp = this.now()) {
    let changed = false;
    const keepAfter = timestamp - (48 * 60 * 60 * 1000);
    for (const [tokenHash, record] of Object.entries(this.state.tokens)) {
      const expiredIssued = record.status === 'issued' && record.expires_at <= timestamp;
      const oldSettled = record.created_at < keepAfter && record.status !== 'consumed';
      if (expiredIssued || oldSettled) {
        delete this.state.tokens[tokenHash];
        changed = true;
      }
    }
    const today = utcDay(timestamp);
    for (const [key, daily] of Object.entries(this.state.daily)) {
      if (key.slice(0, 10) < today && daily.reserved === 0) {
        delete this.state.daily[key];
        changed = true;
      }
    }
    return changed;
  }

  pruneSettledForCapacity() {
    let changed = false;
    const candidates = Object.entries(this.state.tokens)
      .filter(([, record]) => !['issued', 'consumed'].includes(record.status))
      .sort((left, right) => left[1].created_at - right[1].created_at);
    while (Object.keys(this.state.tokens).length >= this.maxRecords && candidates.length) {
      const [tokenHash] = candidates.shift();
      delete this.state.tokens[tokenHash];
      changed = true;
    }
    return changed;
  }

  async recoverIndeterminate() {
    let changed = false;
    for (const tokenHash of Object.keys(this.state.active)) {
      const record = this.state.tokens[tokenHash];
      const daily = this.dailyRecord(record.userHash, record.consumed_at);
      daily.reserved -= record.cost;
      daily.spent += record.cost;
      record.actual_cost = record.cost;
      record.status = 'indeterminate';
      record.settled_at = this.now();
      delete this.state.active[tokenHash];
      changed = true;
    }
    if (changed) await this.persist();
  }

  async issue({ binding, cost, ttlSeconds }) {
    return this.runExclusive(async () => {
      const now = this.now();
      let changed = this.cleanup(now);
      changed = this.pruneSettledForCapacity() || changed;
      const live = Object.values(this.state.tokens).filter((record) => record.status === 'issued' && record.expires_at > now);
      const storageError = (code, message, statusCode = 429) => new ServiceError(code, message, { statusCode });
      let error = null;
      if (live.length >= this.maxLiveGlobal) {
        error = storageError('preview_global_limit', 'The global live-preview limit is reached. Wait for an existing preview to expire.');
      } else if (live.filter((record) => record.userHash === binding.userHash).length >= this.maxLivePerUser) {
        error = storageError('preview_user_limit', 'This user has too many live previews. Wait for one to expire.');
      } else if (live.filter((record) => record.keyHash === binding.keyHash).length >= this.maxLivePerKey) {
        error = storageError('preview_key_limit', 'This API-key fingerprint has too many live previews. Wait for one to expire.');
      } else if (Object.keys(this.state.tokens).length >= this.maxRecords) {
        error = storageError('preview_storage_limit', 'The bounded preview ledger reached its record limit.', 503);
      }
      if (error) {
        if (changed) await this.persist();
        throw error;
      }

      const daily = this.dailyRecord(binding.userHash, now);
      if (daily.spent + daily.reserved + cost > binding.dailyBudget) {
        if (changed) await this.persist();
        throw new ServiceError('daily_credit_limit', 'This preview would exceed the request-scoped daily Firecrawl credit limit.', {
          statusCode: 429,
          details: { limit: binding.dailyBudget, committed: daily.spent + daily.reserved, requested: cost },
        });
      }
      const token = randomBytes(32).toString('base64url');
      const tokenHash = sha256(token);
      const expiresAt = now + (ttlSeconds * 1000);
      const record = {
        ...binding,
        cost,
        created_at: now,
        expires_at: expiresAt,
        status: 'issued',
      };
      if (!validTokenRecord(record)) {
        throw new ServiceError('invalid_preview_binding', 'The preview binding, cost, or lifetime is invalid.', { statusCode: 500 });
      }
      this.state.tokens[tokenHash] = record;
      await this.persist();
      return { token, expiresAt, dailyCommitted: daily.spent + daily.reserved };
    });
  }

  async consume({ token, binding, cost }) {
    return this.runExclusive(async () => {
      const now = this.now();
      const tokenHash = sha256(token);
      const record = this.state.tokens[tokenHash];
      if (!record) throw new ServiceError('invalid_preview_token', 'The preview token is not recognized.', { statusCode: 400 });
      if (record.status !== 'issued') throw new ServiceError('preview_token_used', 'The preview token has already been consumed.', { statusCode: 409 });
      if (record.expires_at <= now) {
        record.status = 'expired';
        await this.persist();
        throw new ServiceError('preview_token_expired', 'The preview token expired. Request a new preview.', { statusCode: 409 });
      }
      const fields = [
        'userHash', 'keyHash', 'tool', 'argsHash', 'dnsHash', 'buildSha',
        'sourceFingerprint', 'descriptorHash', 'operationBudget', 'dailyBudget',
      ];
      const mismatch = fields.find((field) => record[field] !== binding[field]) || (record.cost !== cost ? 'cost' : null);
      if (mismatch) {
        throw new ServiceError('preview_binding_mismatch', 'The preview token does not match this identity, key, tool, arguments, DNS set, build, descriptor, budgets, or projected cost.', {
          statusCode: 409,
          details: { mismatch },
        });
      }
      const activeForKey = Object.values(this.state.active).filter((item) => item.keyHash === record.keyHash).length;
      if (activeForKey >= this.maxInFlight) {
        throw new ServiceError('paid_request_in_flight', 'Another paid Firecrawl request is already in flight for this API-key fingerprint.', {
          statusCode: 409,
        });
      }
      const daily = this.dailyRecord(record.userHash, now);
      if (daily.spent + daily.reserved + cost > record.dailyBudget) {
        throw new ServiceError('daily_credit_limit', 'The request-scoped daily credit limit was reached after preview.', { statusCode: 429 });
      }
      record.status = 'consumed';
      record.consumed_at = now;
      daily.reserved += cost;
      this.state.active[tokenHash] = {
        userHash: record.userHash,
        keyHash: record.keyHash,
        tool: record.tool,
        started_at: now,
      };
      await this.persist();
      return { tokenHash };
    });
  }

  async settle(tokenHash, outcome = 'spent', actualCost) {
    return this.runExclusive(async () => {
      const record = this.state.tokens[tokenHash];
      if (!record || record.status !== 'consumed') return;
      const charge = actualCost === undefined ? record.cost : actualCost;
      if (!safeInteger(charge, 0)) throw new Error('actual credit usage must be a nonnegative safe integer');
      const daily = this.dailyRecord(record.userHash, record.consumed_at);
      if (!safeInteger(daily.spent + charge)) throw new Error('daily spent counter overflow');
      daily.reserved -= record.cost;
      daily.spent += charge;
      record.actual_cost = charge;
      record.status = outcome === 'indeterminate' ? 'indeterminate' : 'spent';
      record.settled_at = this.now();
      delete this.state.active[tokenHash];
      await this.persist();
    });
  }

  async statusForUser(userHash, keyHash = null) {
    return this.runExclusive(async () => {
      const daily = this.state.daily[this.dailyKey(userHash)] || { spent: 0, reserved: 0 };
      return {
        daily_spent: daily.spent,
        daily_reserved: daily.reserved,
        active_paid_requests: Object.values(this.state.active).filter((item) => (
          item.userHash === userHash && (keyHash === null || item.keyHash === keyHash)
        )).length,
      };
    });
  }
}
