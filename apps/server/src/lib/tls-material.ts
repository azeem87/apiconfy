import { X509Certificate } from 'node:crypto';

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;
const PEM_KEY = /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/;
const PEM_CERT_GLOBAL = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const LONG_BASE64_LINE = /^[A-Za-z0-9+/]{100,}={0,2}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function clean(text: string): string {
  return text.replace(/^\uFEFF/, '').trim();
}

function derToPem(base64: string): string | null {
  const compact = base64.replace(/\s+/g, '');
  if (!BASE64.test(compact) || compact.length % 4 !== 0) return null;
  const der = Buffer.from(compact, 'base64');
  if (der.length === 0 || der[0] !== 0x30) return null;
  const lines = compact.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/**
 * PEM blocks pass through; base64 DER (.cer) is re-wrapped as PEM. A string may hold several PEM
 * blocks plus single-line base64 DER certificates (one per line). Returns null when neither.
 */
function normalizeOne(text: string): string | null {
  const value = clean(text);
  const blocks = value.match(PEM_CERT_GLOBAL) ?? [];
  if (blocks.length === 0) return derToPem(value);
  const derLines = value.replace(PEM_CERT_GLOBAL, '\n').split('\n').map(line => line.trim())
    .filter(line => LONG_BASE64_LINE.test(line));
  const converted = derLines.map(derToPem);
  if (converted.includes(null)) return null;
  return [...blocks, ...converted as string[]].map(block => block.trim()).join('\n') + '\n';
}

/** Accepts one string or a list (one entry per certificate file); each entry is normalized on its own. */
export function tryNormalizeCertificate(input: string | string[]): string | null {
  const parts = (Array.isArray(input) ? input : [input]).map(normalizeOne);
  return parts.includes(null) ? null : (parts as string[]).join('');
}

export function normalizeCertificate(text: string | string[]): string {
  const pem = tryNormalizeCertificate(text);
  if (pem === null) throw new Error('certificate must be PEM or base64-encoded DER');
  return pem;
}

export function isCertificateMaterial(text: string | string[]): boolean {
  return tryNormalizeCertificate(text) !== null;
}

export function isPrivateKeyPem(text: string): boolean {
  return PEM_KEY.test(clean(text));
}

export function normalizePrivateKey(text: string): string {
  const value = clean(text);
  if (!PEM_KEY.test(value)) throw new Error('private key must be PEM');
  return `${value}\n`;
}

/**
 * True when the material holds at least one self-signed (root) certificate. Bun/OpenSSL only
 * trust a chain that ends in a root present in `ca`; unlike a Java keystore, a lone leaf or
 * intermediate is never accepted as a trust anchor.
 */
export function hasSelfSignedRoot(text: string | string[]): boolean {
  const pem = tryNormalizeCertificate(text);
  if (pem === null) return false;
  try {
    return (pem.match(PEM_CERT_GLOBAL) ?? []).some(block => {
      const cert = new X509Certificate(block);
      return cert.subject === cert.issuer && cert.verify(cert.publicKey);
    });
  } catch {
    return false;
  }
}
