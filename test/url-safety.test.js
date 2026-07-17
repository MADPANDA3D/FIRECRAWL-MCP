import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inspectPublicUrl,
  isPublicAddress,
  normalizePublicDomainFilter,
} from '../src/url-safety.js';
import { publicLookup } from './helpers.js';

test('public URL normalization accepts bounded HTTP(S) DNS targets', async () => {
  const inspected = await inspectPublicUrl('https://Example.COM/path?q=1', publicLookup);
  assert.equal(inspected.url, 'https://example.com/path?q=1');
  assert.equal(inspected.hostname, 'example.com');
  assert.equal(inspected.answerCount, 2);
  assert.equal(inspected.dnsHash.length, 64);
});

test('URL parser rejects schemes, credentials, fragments, ports, IP literals, and local names', async () => {
  const blocked = [
    'file:///etc/passwd',
    'ftp://example.com/file',
    'https://user:pass@example.com/',
    'https://example.com/#fragment',
    'https://example.com:8443/',
    'http://127.0.0.1/',
    'https://[::1]/',
    'http://localhost/',
    'http://service.internal/',
    'http://singlelabel/',
  ];
  for (const value of blocked) {
    await assert.rejects(() => inspectPublicUrl(value, publicLookup), /URL|target|hostname|ports/iu, value);
  }
});

test('credential-looking query keys, values, and decoded path segments fail before DNS', async () => {
  let lookups = 0;
  const lookup = async () => { lookups += 1; return publicLookup(); };
  const blocked = [
    'https://example.com/?key=innocent',
    'https://example.com/?code=public',
    'https://example.com/?credential=value',
    'https://example.com/?session=value',
    'https://example.com/?q=AKIA' + 'A'.repeat(16),
    'https://example.com/?q=sk_live_' + 'a'.repeat(24),
    'https://example.com/sk_live_' + 'a'.repeat(24),
    'https://example.com/fc-' + 'a'.repeat(24),
    'https://example.com/Bearer%20' + 'a'.repeat(24),
    'https://example.com/eyJ' + 'a'.repeat(12) + '.eyJ' + 'b'.repeat(12) + '.' + 'c'.repeat(12),
    'https://example.com/sk_live_%2561%2561%2561%2561%2561%2561%2561%2561',
    'https://example.com/?next=%2573k_live_abcdefghijklmnopqrstuvwxyz',
    'https://example.com/?api%255Fkey=abcdefghi',
    'https://example.com/%252573k_live_abcdefghijklmnopqrstuvwxyz',
    'https://example.com/%252525252573k_live_abcdefghijklmnopqrstuvwxyz',
    'https://example.com/path?next=%',
  ];
  for (const value of blocked) {
    await assert.rejects(() => inspectPublicUrl(value, lookup), /credential|sensitive|encoding/iu, value);
  }
  assert.equal(lookups, 0);
});

test('DNS rebinding guard rejects private, reserved, documentation, transition, and tunnel answers', async () => {
  const blocked = [
    ['10.0.0.1', 4],
    ['100.64.0.1', 4],
    ['127.0.0.1', 4],
    ['169.254.1.1', 4],
    ['172.16.0.1', 4],
    ['192.168.1.1', 4],
    ['192.0.2.1', 4],
    ['198.18.0.1', 4],
    ['198.51.100.1', 4],
    ['203.0.113.1', 4],
    ['224.0.0.1', 4],
    ['::1', 6],
    ['fc00::1', 6],
    ['fe80::1', 6],
    ['ff02::1', 6],
    ['2001:db8::1', 6],
    ['2001:0db8::1', 6],
    ['2001:0002::1', 6],
    ['2001:0010::1', 6],
    ['2001:0020::1', 6],
    ['2001:1::4', 6],
    ['2001:100::1', 6],
    ['3fff::1', 6],
    ['3fff:0abc::1', 6],
    ['3ffe::1', 6],
    ['3ffe:831f::1', 6],
    ['3f00::1', 6],
    ['3fff:1000::1', 6],
    ['2606:4700::1%eth0', 6],
    ['::ffff:127.0.0.1', 6],
    ['64:ff9b::7f00:1', 6],
    ['2001:0000:4136:e378:8000:63bf:3fff:fdd2', 6],
    ['2002:7f00:0001::1', 6],
  ];
  for (const [address, family] of blocked) {
    assert.equal(isPublicAddress(address), false, address);
    await assert.rejects(
      () => inspectPublicUrl('https://example.com/', async () => [{ address, family }]),
      /private|reserved|invalid/iu,
      address,
    );
  }
});

test('known allocated global IPv6 addresses remain allowed', () => {
  assert.equal(isPublicAddress('2001:4860:4860::8888'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('mixed public and private DNS sets fail closed', async () => {
  await assert.rejects(() => inspectPublicUrl('https://example.com/', async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]), /private|reserved/iu);
});

test('public domain filters normalize IDNs and reject IP/local/invalid names', () => {
  assert.equal(normalizePublicDomainFilter('EXAMPLE.com'), 'example.com');
  assert.equal(normalizePublicDomainFilter('bücher.de'), 'xn--bcher-kva.de');
  for (const value of ['localhost', '127.0.0.1', 'bad domain', 'service.local']) {
    assert.throws(() => normalizePublicDomainFilter(value), /public|hostname|target/iu);
  }
});
