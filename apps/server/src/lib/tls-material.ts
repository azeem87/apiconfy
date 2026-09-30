import { X509Certificate } from 'node:crypto';

const PEM_KEY = /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/;
const PEM_CERT_GLOBAL = /-----BEGIN (?:TRUSTED |X509 )?CERTIFICATE-----[\s\S]+?-----END (?:TRUSTED |X509 )?CERTIFICATE-----/g;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MIN_FIRST_DER_LINE = 16;

/** Env values and .env files often carry PEM with literal `\n` instead of real newlines. */
function clean(text: string): string {
  const value = text.replace(/^\uFEFF/, '').trim();
  return value.includes('-----BEGIN') ? value.replace(/(?:\\r)?\\n/g, '\n') : value;
}

/** Parses one certificate (PEM of any certificate label, or base64 DER) into canonical PEM. */
function toCanonicalPem(input: string | Buffer): string | null {
  try {
    return new X509Certificate(input).toString();
  } catch {
    return null;
  }
}

function derToPem(base64: string): string | null {
  const compact = base64.replace(/\s+/g, '');
  if (!BASE64.test(compact) || compact.length % 4 !== 0) return null;
  return toCanonicalPem(Buffer.from(compact, 'base64'));
}

/** Consecutive base64 lines (a wrapped or single-line DER certificate); other text is skipped. */
function base64Groups(text: string): string[] {
  const groups: string[][] = [];
  let current: string[] | null = null;
  for (const line of text.split('\n').map(item => item.trim())) {
    const isBase64 = BASE64.test(line) && (current !== null || line.length >= MIN_FIRST_DER_LINE);
    if (isBase64) {
      current ??= [];
      current.push(line);
      if (current.length === 1) groups.push(current);
    } else {
      current = null;
    }
  }
  return groups.map(group => group.join(''));
}

/**
 * PEM blocks (CERTIFICATE, TRUSTED CERTIFICATE) and base64 DER (.cer, wrapped or single-line) are
 * each parsed as a real certificate and re-emitted as PEM, so anything else — a private key, a
 * truncated blob — fails loudly instead of being dropped. Non-certificate text is ignored.
 */
function normalizeOne(text: string): string | null {
  const value = clean(text);
  const blocks = value.match(PEM_CERT_GLOBAL) ?? [];
  const leftovers = base64Groups(value.replace(PEM_CERT_GLOBAL, '\n'));
  const converted = [...blocks.map(toCanonicalPem), ...leftovers.map(derToPem)];
  if (converted.length === 0 || converted.includes(null)) return null;
  return (converted as string[]).join('');
}

/** Accepts one string or a list (one entry per certificate file); each entry is normalized on its own. */
export function tryNormalizeCertificate(input: string | string[]): string | null {
  const list = Array.isArray(input) ? input : [input];
  if (list.length === 0) return null;
  const parts = list.map(normalizeOne);
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
