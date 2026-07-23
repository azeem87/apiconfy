import { describe, it, expect } from 'bun:test';
import { isJsonContentType, isFormUrlEncoded, parseResponseBody } from '@/lib/http.js';

describe('HTTP utilities', () => {
  it('isJsonContentType detects JSON', () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    expect(isJsonContentType(headers)).toBe(true);
    expect(isJsonContentType(new Headers())).toBe(false);
  });

  it('isFormUrlEncoded detects form data', () => {
    const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
    expect(isFormUrlEncoded(headers)).toBe(true);
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
