import type { SSLConfig } from '@/core/types.js';
import { hasSelfSignedRoot, normalizeCertificate, normalizePrivateKey } from '@/lib/tls-material.js';
import { ConnectionError } from '@/lib/errors.js';

export function buildTlsOptions(ssl: SSLConfig | undefined, disableSSL?: boolean): Record<string, unknown> | undefined {
  const tls: Record<string, unknown> = {};
  try {
    if (ssl?.ca !== undefined) tls.ca = normalizeCertificate(ssl.ca);
    if (ssl?.cert !== undefined) tls.cert = normalizeCertificate(ssl.cert);
    if (ssl?.key !== undefined) tls.key = normalizePrivateKey(ssl.key);
  } catch {
    const field = ssl?.ca !== undefined && !('ca' in tls) ? 'ssl.ca' : ssl?.cert !== undefined && !('cert' in tls) ? 'ssl.cert' : 'ssl.key';
    throw new ConnectionError(`${field} is not valid ${field === 'ssl.key' ? 'PEM private key' : 'PEM or base64-encoded DER certificate'} material`);
  }
  // Env-supplied `ca` is only visible here, so the registration-time root rule is re-checked.
  if (typeof tls.ca === 'string' && !hasSelfSignedRoot(tls.ca)) {
    throw new ConnectionError('ssl.ca must include the self-signed root certificate of the server chain');
  }
  if (ssl?.passphrase !== undefined) tls.passphrase = ssl.passphrase;
  if (disableSSL === true || ssl?.disableSSL === true) tls.rejectUnauthorized = false;
  return Object.keys(tls).length ? tls : undefined;
}
