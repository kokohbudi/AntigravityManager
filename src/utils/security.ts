import keytar from 'keytar';
import crypto from 'crypto';
import { logger } from './logger';

const SERVICE_NAME = 'AntigravityManager';
const ACCOUNT_NAME = 'MasterKey';

import fs from 'fs';
import path from 'path';
import { getAgentDir } from './paths';

// Cache the key in memory to avoid frequent system calls
let cachedMasterKey: Buffer | null = null;

async function getOrGenerateMasterKey(): Promise<Buffer> {
  if (cachedMasterKey) return cachedMasterKey;

  // Strategy 1: Try Keytar (System Keychain)
  try {
    const hexKey = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
    if (hexKey) {
      cachedMasterKey = Buffer.from(hexKey, 'hex');
      return cachedMasterKey;
    }
  } catch (error) {
    logger.warn('Security: Failed to read from keychain, falling back to file storage.', error);
  }

  // Strategy 2: File-based fallback
  const fallbackPath = path.join(getAgentDir(), 'master.key');

  if (fs.existsSync(fallbackPath)) {
    try {
      const hexKey = fs.readFileSync(fallbackPath, 'utf-8').trim();
      if (hexKey) {
        cachedMasterKey = Buffer.from(hexKey, 'hex');
        return cachedMasterKey;
      }
    } catch (e) {
      logger.error('Security: Failed to read fallback key file', e);
    }
  }

  // Strategy 3: Generate New Key
  logger.info('Security: Generating new master key...');
  const buffer = crypto.randomBytes(32);
  const hexKey = buffer.toString('hex');
  cachedMasterKey = Buffer.from(hexKey, 'hex');

  // Try to save to Keytar first
  let keytarSaved = false;
  try {
    await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, hexKey);
    keytarSaved = true;
  } catch (error) {
    logger.warn('Security: Failed to save to keychain, attempting to save to file.', error);
  }

  // If Keytar failed or we are in fallback mode anyway (implied by execution flow if we didn't return earlier)
  // Actually, if keytar worked for saving, great. But if we are here, it likely means we either generated a fresh key (first run) OR fell back.
  // If we fell back during READ, we should save to FILE too, to be consistent?
  // No, if we generated a NEW key, we try keytar. If that fails, we MUST save to file.

  if (!keytarSaved) {
    try {
      const agentDir = getAgentDir();
      if (!fs.existsSync(agentDir)) {
        fs.mkdirSync(agentDir, { recursive: true });
      }
      // write with restricted permissions (0o600 = read/write only by owner)
      fs.writeFileSync(fallbackPath, hexKey, { encoding: 'utf-8', mode: 0o600 });
      logger.info('Security: Master key saved to fallback file.');
    } catch (e) {
      logger.error('Security: Failed to save fallback key file', e);
      throw new Error('Critical: Unable to save master key to keychain or file.');
    }
  }

  return cachedMasterKey;
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypts a string using AES-256-GCM.
 * Output format: "iv_hex:auth_tag_hex:ciphertext_hex"
 */
export async function encrypt(text: string): Promise<string> {
  try {
    const key = await getOrGenerateMasterKey();
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:encrypted
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  } catch (error) {
    logger.error('Security: Encryption failed', error);
    throw error;
  }
}

/**
 * Decrypts a string using AES-256-GCM.
 * Input format: "iv_hex:auth_tag_hex:ciphertext_hex"
 */
export async function decrypt(text: string): Promise<string> {
  // Check if it's plain text (JSON) for backward compatibility
  // Very rough check: starts with { or [
  if (text.startsWith('{') || text.startsWith('[')) {
    return text;
  }

  // Also checking if it follows our pattern
  const parts = text.split(':');
  if (parts.length !== 3) {
    // Treat as plain text if it doesn't look like our encrypted format
    return text;
  }

  try {
    const key = await getOrGenerateMasterKey();

    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    logger.error('Security: Decryption failed', error);
    // If decryption fails, it might be corrupted or using a different key.
    throw error;
  }
}
