import { createHash, timingSafeEqual } from 'node:crypto';

const safeEqual = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

const normalizeSecret = (value, minimum) => {
  if (Array.isArray(value) || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < minimum || trimmed.length > 4096 || /[\r\n\0]/u.test(trimmed)) return null;
  return trimmed;
};

export const isPortalGrantValid = (provided, configured) => safeEqual(provided, configured);
export const isAccessTokenValid = (authorization, configured) => {
  if (Array.isArray(authorization) || typeof authorization !== 'string') return false;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/u.exec(authorization);
  const token = match?.[1];
  return typeof token === 'string'
    && token.length >= 32
    && token.length <= 4096
    && safeEqual(token, configured);
};
export const normalizeFirecrawlApiKey = (value) => normalizeSecret(value, 8);
export const normalizeUserId = (value) => {
  if (Array.isArray(value) || typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(trimmed) ? trimmed : null;
};
export const fingerprint = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
