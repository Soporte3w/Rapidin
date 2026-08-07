import { createHash, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';

const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$/;
const SHA256_HASH_PATTERN = /^[a-f0-9]{64}$/i;

function verifyLegacySha256(password, storedHash) {
  const candidateHash = createHash('sha256').update(password).digest();
  const storedHashBuffer = Buffer.from(storedHash, 'hex');
  return storedHashBuffer.length === candidateHash.length && timingSafeEqual(candidateHash, storedHashBuffer);
}

export async function verifyStoredPassword(password, storedHash) {
  if (typeof password !== 'string' || typeof storedHash !== 'string') return false;
  if (BCRYPT_HASH_PATTERN.test(storedHash)) return bcrypt.compare(password, storedHash);
  if (SHA256_HASH_PATTERN.test(storedHash)) return verifyLegacySha256(password, storedHash);
  return false;
}
