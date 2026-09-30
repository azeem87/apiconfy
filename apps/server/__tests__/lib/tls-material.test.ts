import { describe, expect, it } from 'bun:test';
import {
  hasSelfSignedRoot, isCertificateMaterial, isPrivateKeyPem, normalizeCertificate, normalizePrivateKey,
} from '@/lib/tls-material.js';
import { CA_CERT, CA_CERT_DER_BASE64, CLIENT_A_KEY, SERVER_CERT, SERVER_KEY } from '../fixtures/tls.js';

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

  it('detects a self-signed root in PEM, DER and bundles; a lone leaf or garbage has none', () => {
    expect(hasSelfSignedRoot(CA_CERT)).toBe(true);
    expect(hasSelfSignedRoot(CA_CERT_DER_BASE64)).toBe(true);
    expect(hasSelfSignedRoot(`${SERVER_CERT}${CA_CERT}`)).toBe(true);
    expect(hasSelfSignedRoot(SERVER_CERT)).toBe(false);
    expect(hasSelfSignedRoot('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----')).toBe(false);
  });

  it('accepts PEM blocks mixed with single-line base64 DER certs, and normalizes all to PEM', () => {
    const mixed = `${SERVER_CERT}\n${CA_CERT_DER_BASE64}\n`;
    const pem = normalizeCertificate(mixed);
    expect(pem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(pem).toContain(CA_CERT.trim());
    expect(hasSelfSignedRoot(mixed)).toBe(true);
  });

  it('ignores non-certificate text around PEM blocks but rejects an undecodable DER-looking line', () => {
    expect(normalizeCertificate(`Bag Attributes\n  friendlyName: x\n${CA_CERT}`)).toBe(CA_CERT.trim() + '\n');
    expect(isCertificateMaterial(`${CA_CERT}\n${'A'.repeat(120)}`)).toBe(false);
  });

  it('never accepts a private key as a certificate, in PEM or base64 DER', () => {
    const keyDerBase64 = CLIENT_A_KEY.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    expect(isCertificateMaterial(keyDerBase64)).toBe(false);
    expect(isCertificateMaterial(CLIENT_A_KEY)).toBe(false);
    expect(isCertificateMaterial(`${CA_CERT}\n${keyDerBase64}`)).toBe(false);
  });

  it('accepts wrapped base64 DER next to PEM instead of silently dropping it', () => {
    const wrapped = CA_CERT_DER_BASE64.replace(/(.{64})/g, '$1\n');
    const pem = normalizeCertificate(`${SERVER_CERT}\n${wrapped}`);
    expect(pem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(pem).toContain(CA_CERT.trim());
  });

  it('accepts TRUSTED CERTIFICATE blocks and re-emits them as CERTIFICATE', () => {
    const trusted = CA_CERT.replace(/CERTIFICATE/g, 'TRUSTED CERTIFICATE');
    const pem = normalizeCertificate(`${SERVER_CERT}\n${trusted}`);
    expect(pem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(pem).not.toContain('TRUSTED');
    expect(hasSelfSignedRoot(`${SERVER_CERT}\n${trusted}`)).toBe(true);
  });

  it('rejects a truncated PEM block and an empty list', () => {
    expect(isCertificateMaterial('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----')).toBe(false);
    expect(isCertificateMaterial([])).toBe(false);
  });

  it('turns literal \\n sequences (typical of env values) into newlines', () => {
    const escaped = CA_CERT.trim().replace(/\n/g, '\\n');
    expect(escaped).not.toContain('\n');
    expect(normalizeCertificate(escaped)).toBe(CA_CERT.trim() + '\n');
    expect(normalizePrivateKey(SERVER_KEY.trim().replace(/\n/g, '\\n'))).toBe(SERVER_KEY.trim() + '\n');
  });
});
