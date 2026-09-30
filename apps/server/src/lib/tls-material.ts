const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;
const PEM_KEY = /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// Env values often carry PEM with escaped "\n" instead of real newlines.
function clean(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\\n/g, '\n').trim();
}

function derToPem(base64: string): string | null {
  const compact = base64.replace(/\s+/g, '');
  if (!BASE64.test(compact) || compact.length % 4 !== 0) return null;
  const der = Buffer.from(compact, 'base64');
  if (der.length === 0 || der[0] !== 0x30) return null;
  const lines = compact.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** PEM passthrough or base64 DER (.cer) re-wrapped as PEM. Returns null when neither. */
export function tryNormalizeCertificate(text: string): string | null {
  const value = clean(text);
  if (PEM_CERT.test(value)) return `${value}\n`;
  return derToPem(value);
}

export function normalizeCertificate(text: string): string {
  const pem = tryNormalizeCertificate(text);
  if (pem === null) throw new Error('certificate must be PEM or base64-encoded DER');
  return pem;
}

export function isCertificateMaterial(text: string): boolean {
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
