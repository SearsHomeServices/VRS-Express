import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "crypto";

export interface EncryptedVrsCallbackSecret {
  cipher: string;
  iv: string;
  authTag: string;
  salt: string;
}

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;

function getMasterSecret(): string {
  const secret = process.env.VRS_BRIDGE_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error(
      "VRS_BRIDGE_ENCRYPTION_KEY (at least 32 characters) is required for callback-secret encryption",
    );
  }
  return secret;
}

export function encryptVrsCallbackSecret(
  secret: string,
): EncryptedVrsCallbackSecret {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = scryptSync(getMasterSecret(), salt, KEY_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);

  return {
    cipher: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    salt: salt.toString("base64"),
  };
}

export function decryptVrsCallbackSecret(
  encrypted: EncryptedVrsCallbackSecret,
): string {
  const salt = Buffer.from(encrypted.salt, "base64");
  const iv = Buffer.from(encrypted.iv, "base64");
  const authTag = Buffer.from(encrypted.authTag, "base64");
  const ciphertext = Buffer.from(encrypted.cipher, "base64");
  const key = scryptSync(getMasterSecret(), salt, KEY_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
