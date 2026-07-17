import { lookup as systemLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

import { ServiceError } from './errors.js';
import {
  containsCredentialMaterial,
  decodeUrlComponentBounded,
  isSensitiveQueryKey,
  pathSegmentContainsCredential,
  sha256,
} from './util.js';

const blockedNameSuffixes = Object.freeze([
  'localhost', '.localhost', '.local', '.internal', '.home', '.lan', '.test', '.invalid', '.example', '.onion',
]);

const isBlockedIPv4 = (address) => {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
};

const ipv6ToBigInt = (address) => {
  let normalized = address.toLowerCase().split('%')[0];
  if (normalized.includes('.')) return null;
  if ((normalized.match(/::/gu) || []).length > 1) return null;
  const [leftText, rightText] = normalized.split('::');
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  const missing = normalized.includes('::') ? 8 - left.length - right.length : 0;
  const groups = normalized.includes('::') ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
};

const ipv6Prefix = (address, bits) => {
  const value = ipv6ToBigInt(address);
  return value === null ? null : value >> BigInt(128 - bits);
};

const inIpv6Cidr = (value, prefixAddress, bits) => (
  value >> BigInt(128 - bits)
) === ipv6Prefix(prefixAddress, bits);

const isBlockedIPv6 = (address) => {
  if (address.includes('%')) return true;
  const value = ipv6ToBigInt(address);
  if (value === null) return true;
  if (!inIpv6Cidr(value, '2000::', 3)) return true;
  return (
    inIpv6Cidr(value, '2001::', 23)
    || inIpv6Cidr(value, '2001:db8::', 32)
    || inIpv6Cidr(value, '2002::', 16)
    || inIpv6Cidr(value, '3f00::', 8)
  );
};

export const isPublicAddress = (address) => {
  const family = isIP(address);
  if (family === 4) return !isBlockedIPv4(address);
  if (family === 6) return !isBlockedIPv6(address);
  return false;
};

const normalizeHostname = (hostname) => {
  const ascii = domainToASCII(hostname).toLowerCase().replace(/\.$/u, '');
  if (!ascii || ascii.length > 253 || isIP(ascii)) {
    throw new ServiceError('blocked_public_target', 'Public targets must use a DNS hostname, not an IP literal.', { statusCode: 400 });
  }
  if (blockedNameSuffixes.some((suffix) => ascii === suffix || (suffix.startsWith('.') && ascii.endsWith(suffix)))) {
    throw new ServiceError('blocked_public_target', 'Local, reserved, or special-use hostnames are not allowed.', { statusCode: 400 });
  }
  const labels = ascii.split('.');
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
    throw new ServiceError('blocked_public_target', 'The target hostname is not a valid public DNS name.', { statusCode: 400 });
  }
  return ascii;
};

export const normalizePublicDomainFilter = (hostname) => normalizeHostname(hostname);

export const inspectPublicUrl = async (value, lookupFn = systemLookup) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ServiceError('invalid_public_url', 'The URL must be a valid absolute HTTP(S) URL.', { statusCode: 400 });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ServiceError('blocked_public_target', 'Only HTTP and HTTPS public URLs are allowed.', { statusCode: 400 });
  }
  if (url.username || url.password || url.hash) {
    throw new ServiceError('blocked_public_target', 'Credentials and fragments are not allowed in public URLs.', { statusCode: 400 });
  }
  if (url.port && !['80', '443'].includes(url.port)) {
    throw new ServiceError('blocked_public_target', 'Only ports 80 and 443 are allowed.', { statusCode: 400 });
  }
  const decodedQuery = [...url.searchParams.entries()].map(([key, value]) => ({
    key: decodeUrlComponentBounded(key),
    value: decodeUrlComponentBounded(value),
  }));
  if (decodedQuery.some(({ key, value }) => key === null || value === null)) {
    throw new ServiceError('blocked_public_target', 'Query encoding must stabilize after bounded decoding.', { statusCode: 400 });
  }
  if (decodedQuery.some(({ key }) => isSensitiveQueryKey(key))) {
    throw new ServiceError('blocked_public_target', 'Sensitive credential or personal-data query parameters are not allowed in public target URLs.', { statusCode: 400 });
  }
  if (decodedQuery.some(({ value: queryValue }) => containsCredentialMaterial(queryValue))) {
    throw new ServiceError('blocked_public_target', 'Credential-looking query values are not allowed in public target URLs.', { statusCode: 400 });
  }
  const pathHasCredential = url.pathname.split('/').some(pathSegmentContainsCredential);
  if (pathHasCredential) {
    throw new ServiceError('blocked_public_target', 'Credential-looking URL path segments are not allowed in public target URLs.', { statusCode: 400 });
  }
  const hostname = normalizeHostname(url.hostname);
  url.hostname = hostname;
  let answers;
  try {
    answers = await lookupFn(hostname, { all: true, verbatim: true });
  } catch {
    throw new ServiceError('public_target_dns_failed', 'The public target hostname could not be resolved.', { statusCode: 400 });
  }
  const normalizedAnswers = [...new Set((answers || []).map((answer) => {
    const address = typeof answer === 'string' ? answer : answer?.address;
    const family = typeof answer === 'string' ? isIP(answer) : Number(answer?.family || isIP(address));
    if (!address || ![4, 6].includes(family) || !isPublicAddress(address)) {
      throw new ServiceError('blocked_public_target', 'The public target resolved to a private, reserved, or invalid address.', { statusCode: 400 });
    }
    return String(family) + ':' + address.toLowerCase();
  }))].sort();
  if (normalizedAnswers.length === 0) {
    throw new ServiceError('public_target_dns_failed', 'The public target hostname returned no usable DNS answers.', { statusCode: 400 });
  }
  return Object.freeze({
    url: url.toString(),
    hostname,
    dnsHash: sha256(JSON.stringify(normalizedAnswers)),
    answerCount: normalizedAnswers.length,
  });
};
