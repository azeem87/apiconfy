import { describe, it, expect } from 'bun:test';
import { mediaType, parseResponseBody } from '@/lib/http.js';

describe('HTTP utilities', () => {
  it.each([
    ['application/json', 'application/json'],
    ['application/json; charset=utf-8', 'application/json'],
    ['  APPLICATION/JSON  ', 'application/json'],
    ['application/x-www-form-urlencoded;charset=utf8', 'application/x-www-form-urlencoded'],
    ['', ''],
  ])('mediaType normalizes %s to %s', (header, expected) => {
    expect(mediaType(header)).toBe(expected);
  });

  it('mediaType does not match a longer media type that merely contains a prefix', () => {
    // The reason this helper replaced a substring check: `includes('application/json')`
    // accepted `application/jsonp` as JSON.
    expect(mediaType('application/jsonp')).not.toBe('application/json');
    expect(mediaType('text/application/json')).not.toBe('application/json');
  });

  it('parseResponseBody parses JSON', async () => {
    const res = new Response(JSON.stringify({ a: 1 }), {
      headers: { 'content-type': 'application/json' },
    });
    const body = await parseResponseBody(res);
    expect(body).toEqual({ a: 1 });
  });

  it('parseResponseBody returns text for non-JSON', async () => {
    const res = new Response('hello', {
      headers: { 'content-type': 'text/plain' },
    });
    const body = await parseResponseBody(res);
    expect(body).toBe('hello');
  });
});
