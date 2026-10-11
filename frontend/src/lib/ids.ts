/** Local model IDs also work on HTTP previews accessed through a tailnet. */
export function createId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 48 bits of milliseconds and 80 cryptographically random bits, in Crockford base32. */
export function createUlid(now = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now >= 2 ** 48)
    throw new RangeError('ULID time must be an integer between 0 and 2^48 - 1');
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let value = BigInt(now);
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let id = '';
  for (let index = 0; index < 26; index++) {
    id = crockford[Number(value & 31n)] + id;
    value >>= 5n;
  }
  return id;
}
