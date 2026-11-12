// Reference values produced exactly the way src/lib/auth.ts does it, for the Python parity tests.
const crypto = require('node:crypto');

const secret = 'test-secret-öçü-2026'; // non-ASCII on purpose: the secret is used as UTF-8 text
const sid = 'ses_0a1b2c3d4e5f6g7h';
const sig = crypto.createHmac('sha256', secret).update(sid).digest('base64url');

const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const password = 'Parol-123!ўқ';
const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
const passwordHash = ['scrypt', '16384', '8', '1', salt.toString('base64'), derived.toString('base64')].join('$');

const raw = 'ovoz_sk_' + Buffer.from('cafebabe00112233445566778899aabbccddeeff00112233', 'hex').toString('base64url');

console.log(
  JSON.stringify(
    {
      secret,
      sid,
      token: sid + '.' + sig,
      password,
      password_hash: passwordHash,
      api_key: raw,
      api_key_prefix: raw.slice(0, 16),
      api_key_sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    },
    null,
    2,
  ),
);
