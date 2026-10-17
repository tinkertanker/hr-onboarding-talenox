// Authenticated encryption for personal data that leaves process memory
// (Durable Object storage, queue messages). AES-GCM via WebCrypto works in both
// Node and Cloudflare Workers. The context is part of key derivation, so a sealed
// value only opens with the same key material and context.

const crypto = require('crypto');

const deriveKey = (keyMaterial, context) => globalThis.crypto.subtle.importKey(
  'raw',
  crypto.createHmac('sha256', keyMaterial).update(`seal:${context}`).digest(),
  'AES-GCM',
  false,
  ['encrypt', 'decrypt']
);

const sealJson = async (value, keyMaterial, context) => {
  const iv = crypto.randomBytes(12);
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await deriveKey(keyMaterial, context),
    Buffer.from(JSON.stringify(value), 'utf8')
  );
  return `${iv.toString('base64')}.${Buffer.from(ciphertext).toString('base64')}`;
};

const openJson = async (sealed, keyMaterial, context) => {
  const [iv, ciphertext] = String(sealed).split('.');
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(iv || '', 'base64') },
    await deriveKey(keyMaterial, context),
    Buffer.from(ciphertext || '', 'base64')
  );
  return JSON.parse(Buffer.from(plaintext).toString('utf8'));
};

module.exports = { sealJson, openJson };
