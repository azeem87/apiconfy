import { describe, expect, it } from 'bun:test';
import {
  isCertificateMaterial, isPrivateKeyPem, normalizeCertificate, normalizePrivateKey,
} from '@/lib/tls-material.js';
import { CA_CERT, CA_CERT_DER_BASE64, SERVER_KEY } from '../fixtures/tls.js';

describe('tls-material', () => {
  it('passes PEM through', () => {
    expect(normalizeCertificate(CA_CERT)).toBe(CA_CERT.trim() + '\n');
  });

  it('re-wraps base64 DER as PEM equal to the original cert', () => {
    expect(normalizeCertificate(CA_CERT_DER_BASE64)).toBe(CA_CERT.trim() + '\n');
    expect(normalizeCertificate(`\uFEFF ${CA_CERT_DER_BASE64.replace(/(.{64})/g, '$1\n')} `)).toBe(CA_CERT.trim() + '\n');
  });

  it('rejects garbage', () => {
    for (const bad of ['', 'hello', 'AAAA', '!!!!', Buffer.from('nope').toString('base64')]) {
      expect(() => normalizeCertificate(bad)).toThrow();
      expect(isCertificateMaterial(bad)).toBe(false);
    }
  });

  it('accepts every private key header and rejects others', () => {
    for (const kind of ['', 'RSA ', 'EC ', 'ENCRYPTED ']) {
      const pem = `-----BEGIN ${kind}PRIVATE KEY-----\nabc\n-----END ${kind}PRIVATE KEY-----`;
      expect(isPrivateKeyPem(pem)).toBe(true);
    }
    expect(isPrivateKeyPem(CA_CERT)).toBe(false);
    expect(() => normalizePrivateKey('MIIB')).toThrow();
  });
});
