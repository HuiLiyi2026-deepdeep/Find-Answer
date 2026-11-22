// Verified on the deployed gateway: these two are overwritten server-side.
// x-forwarded-for, x-real-client-ip and remoteip stay out because a client
// supplied value survives (or is appended) there.
const IP_HEADERS = [
  'x-envoy-external-address',
  'x-real-ip',
];

const shanghaiDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function validIpv4(value) {
  const parts = value.split('.');
  return parts.length === 4
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function validIpv6(value) {
  if (!value.includes(':') || value.includes('%')) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.startsWith('[');
  } catch {
    return false;
  }
}

export function isIpLiteral(value) {
  return typeof value === 'string'
    && (validIpv4(value) || validIpv6(value));
}

export function trustedClientIp(request) {
  for (const name of IP_HEADERS) {
    const raw = request.headers.get(name);
    if (raw === null) continue;
    // Exactly one value is allowed: a comma-separated list or a duplicated
    // header must fail closed instead of trusting the first entry.
    const values = raw.split(',').map((value) => value.trim());
    if (values.length !== 1) return null;
    const candidate = values[0];
    if (!isIpLiteral(candidate)) return null;
    return { ip: candidate.toLowerCase(), source: name };
  }
  return null;
}

export async function hashIp(ip) {
  const bytes = new TextEncoder().encode(`findanswer:public-ip:v1:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export function dayKey(date) {
  return shanghaiDay.format(date);
}
