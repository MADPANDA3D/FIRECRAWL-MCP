import { ServiceError } from './errors.js';
import { isPlainObject } from './util.js';

const fail = (path, message) => {
  throw new ServiceError('validation_error', `${path} ${message}`, { statusCode: 400, details: { field: path } });
};

const valueType = (value) => {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
};

export const validateAgainstSchema = (value, schema, path = 'arguments') => {
  if (schema.const !== undefined && value !== schema.const) fail(path, `must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) fail(path, `must be one of: ${schema.enum.join(', ')}`);
  if (schema.type) {
    const actual = valueType(value);
    const accepted = schema.type === 'number' && actual === 'integer' ? 'number' : actual;
    if (accepted !== schema.type) fail(path, `must be ${schema.type}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(path, `must contain at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(path, `must contain at most ${schema.maxLength} characters`);
    if (schema.pattern && !(new RegExp(schema.pattern, 'u')).test(value)) fail(path, 'has an invalid format');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'must be finite');
    if (schema.minimum !== undefined && value < schema.minimum) fail(path, `must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(path, `must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(path, `must contain at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(path, `must contain at most ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) fail(path, 'must contain unique items');
    if (schema.items) value.forEach((item, index) => validateAgainstSchema(item, schema.items, `${path}[${index}]`));
  }
  if (schema.type === 'object') {
    if (!isPlainObject(value)) fail(path, 'must be an object');
    const properties = schema.properties || {};
    for (const required of schema.required || []) if (!Object.hasOwn(value, required)) fail(`${path}.${required}`, 'is required');
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) fail(`${path}.${key}`, 'is not allowed');
    }
    for (const [key, child] of Object.entries(value)) if (properties[key]) validateAgainstSchema(child, properties[key], `${path}.${key}`);
  }
  return value;
};
