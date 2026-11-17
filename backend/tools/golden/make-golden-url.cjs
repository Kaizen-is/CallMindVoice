// What `new URL(input)` does in Node for assorted inputs: its `.protocol`, or null when it throws.
// The webhook form (saveWebhookAction) accepts a URL only when it parses and is https:, and
// `js_url_protocol` in backend/app/jscompat.py must answer exactly the same.
// Usage: node make-golden-url.cjs <output.json>
const fs = require('fs');

const FIXED = [
  '', ' ', 'https://example.com', 'https://example.com/hook', 'http://example.com', 'example.com', 'example.com/hook',
  '//example.com', 'https:example.com', 'https:/example.com', 'https:///example.com', 'https:\\\\example.com',
  'HTTPS://EXAMPLE.COM', '  https://example.com  ', '\thttps://exa\nmple.com', 'https://', 'https:///', 'https://?x',
  'https://#x', 'https://@', 'https://u@', 'https://u:p@h.com', 'https://u:p@', 'https://:80', 'https://h:',
  'https://h:80', 'https://h:65535', 'https://h:65536', 'https://h:0080', 'https://h:8a', 'https://h: 80',
  'https://exa mple.com', 'https://exa%20mple.com', 'https://a%41.com', 'https://a%2541.com', 'https://a%zz.com',
  'https://a%.com', 'https://a%ff.com', 'https://a%c3%a9.com', 'https://é.com', 'https://ÉXAMPLE.com', 'https://☕.com',
  'https://xn--53h.com', 'https://xn--abc.com', 'https://xn--.com', 'https://xn--a.com', 'https://xn--ls8h.la',
  'https://xn--zz-.com', 'https://xn--a-ecp.ru', 'https://xn---.com', 'https://bücher.de', 'https://xn--bcher-kva.de',
  'https://مثال.com', 'https://a.مثال', 'https://1.مثال', 'https://abc-.مثال', 'https://פוליקר.co.il', 'https://aא.com',
  'https://aאא.com', 'https://אa.com', 'https://1א.com', 'https://א_.com', 'https://١a.com', 'https://1١.com',
  'https://a\u200db.com', 'https://a\u200cb.com', 'https://\u0915\u094d\u200d.com', 'https://\u00ad.com',
  'https://%C2%AD', 'https://\ufeffa.com', 'https://a\u3002b.com', 'https://ａｂｃ.com', 'https://a..b', 'https://.',
  'https://..', 'https://a.', 'https://-a-.com', 'https://a--b.com', 'https://127.0.0.1', 'https://127.0.0.256',
  'https://256.0.0.1', 'https://1.2.3.4.5', 'https://1.2.3.4.', 'https://0x7f.1', 'https://0x.1', 'https://0x',
  'https://foo.0x', 'https://foo.09', 'https://foo.08', 'https://foo.1', 'https://1', 'https://4294967295',
  'https://4294967296', 'https://0xffffffff', 'https://0x100000000', 'https://00', 'https://017700000001', 'https://1.0x',
  'https://foo.bar.', 'https://foo.1.', 'https://[::1]', 'https://[::1', 'https://[::1]:80', 'https://[::1]x',
  'https://[1:2:3:4:5:6:7:8]', 'https://[1:2:3:4:5:6:7:8:9]', 'https://[1:2:3:4:5:6:7]', 'https://[::ffff:1.2.3.4]',
  'https://[::1.2.3.4.5]', 'https://[::1.2.3]', 'https://[::01.2.3.4]', 'https://[1::2::3]', 'https://[:1]', 'https://[1:]',
  'https://[]', 'https://[::]', 'https://[g::1]', 'https://[::1%25eth0]', 'https://a[b]', 'https://a]b', 'https://a^b',
  'https://a|b', 'https://a<b', 'https://a\\b', 'https://a\x00b', 'https://a\x01b', 'https://a\x7fb', "https://a'b",
  'https://a"b', 'https://a`b', 'https://a{b}', 'https://a!b', 'https://a$b&c', 'https://a*b', 'https://a,b',
  'https://a;b', 'https://a=b', 'https://a+b', 'https://a~b', 'https://a_b', 'ftp://x', 'ftp://', 'ws://x', 'wss://',
  'file:', 'file:/x', 'file://', 'file:///x', 'file://h/x', 'file://C:/x', 'file://C|/x', 'file://exa mple/x',
  'file://h:80/x', 'file://@h/x', 'file://localhost/x', 'file:\\\\h\\x', 'mailto:a@b', 'javascript:alert(1)',
  'data:text/plain,x', 'a:b', 'a:', 'A:b', '1a:b', '+a:b', 'a+b-c.d:e', 'a_b:c', 'foo://', 'foo://@', 'foo://h',
  'foo://h:80', 'foo://h:8x', 'foo://:80', 'foo://a b', 'foo://a%b', 'foo://a[b]', 'foo://[::1]', 'foo://[::1',
  'foo://a^b', 'foo://ä', 'foo:/x', 'foo:///x', 'foo:x y', 'foo://a@b@c', 'foo://a@', 'https://a@b@c', 'https://a/b@c',
  'https://a?b@c', 'https://a#b@c', 'https://a\\b@c', 'foo://a\\b@c', 'http://a:b@c:d', 'https://\ud83d.com',
  'https://a.com/\ud83d', 'https://XN--53H.COM', 'https://Ⅷ.com', 'https://ß.de', 'https://ς.gr', 'https://\u0301a.com',
  'https://a\u0301.com', 'https://\u2488.com', 'https://\uff0e.com', 'https://%e2%98%95.com', 'https://%2e',
  'https://a%2eb', 'https://%31%32%37.0.0.1', 'https://%5B::1%5D', '\x00https://a.com', 'https://a.com\x1f',
  'ht\ttps://a.com', 'https://a.com:\t80', 'https://hooks.slack.com/services/T000/B000/XXXX',
];

let state = 20261117;
const rnd = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const SCHEMES = ['https', 'http', 'HTTPS', 'ftp', 'file', 'foo', 'ws', '1x', 'x', ''];
const SEPS = ['://', ':', ':/', ':///', ':\\\\', '//', ':/\\', ''];
const CREDS = ['', 'u@', 'u:p@', '@', 'a@b@', ':@'];
const HOSTCH = [...'abcxyz019.-_%:[]@ ^|<>\\#?/', 'é', '☕', '\u200d', 'xn--', '0x', 'ff', '%41', '%zz', '%c3%a9', 'مث'];
const PORTS = ['', ':', ':80', ':65536', ':8x', ':0', '::'];
const PATHS = ['', '/', '/x', '?q', '#f', '/a b', '\\x'];
const randomUrl = () => {
  let host = '';
  for (let i = Math.floor(rnd() * 7); i > 0; i--) host += pick(HOSTCH);
  return pick(SCHEMES) + pick(SEPS) + pick(CREDS) + host + pick(PORTS) + pick(PATHS);
};
const randomIp = () => {
  const parts = [];
  for (let i = 1 + Math.floor(rnd() * 5); i > 0; i--) parts.push(pick(['0', '1', '255', '256', '0x10', '0x', '08', '07', '4294967295', '', 'a']));
  return 'https://' + parts.join('.') + pick(['', '.']);
};
const randomV6 = () => {
  const pieces = [];
  for (let i = 1 + Math.floor(rnd() * 9); i > 0; i--) pieces.push(pick(['', '1', 'ffff', 'fffff', 'g', '0', '1.2.3.4', '1.2.3', '01.2.3.4']));
  return 'https://[' + pieces.join(':') + ']';
};

const inputs = [...FIXED];
for (let i = 0; i < 1500; i++) inputs.push(randomUrl());
for (let i = 0; i < 300; i++) inputs.push(randomIp());
for (let i = 0; i < 300; i++) inputs.push(randomV6());
const cases = inputs.map((input) => {
  try {
    return [input, new URL(input).protocol];
  } catch {
    return [input, null];
  }
});
fs.writeFileSync(process.argv[2], JSON.stringify({ node: process.version, cases }, null, 0) + '\n');
console.log(`${cases.length} cases`);
