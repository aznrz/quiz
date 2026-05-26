// Cloudflare Worker entry point for app.ms-cert.workers.dev.
//
// Three responsibilities, in order:
//   1. Hotlink protection on /assets/db1/* and /assets/db2/* — block
//      requests whose Referer points at a foreign domain.
//   2. Per-IP rate limit on the same paths via the RateLimiter Durable
//      Object — 50 requests/minute, return 429 if exceeded.
//   3. Suspicious-pattern alerting — when an IP crosses 100 image
//      fetches in a single hour, fire a Telegram message (once per
//      hour per IP). Set TG_BOT_TOKEN + TG_CHAT_ID via
//      `wrangler secret put` to enable; otherwise the event only
//      lands in `wrangler tail` / Cloudflare logs.
//
// Static asset serving is delegated to env.ASSETS. On any unexpected
// error in this script we still call env.ASSETS.fetch so a buggy edit
// here can never take the whole site down.

import { RateLimiter } from './_rate-limiter.js';
export { RateLimiter };

const PROTECTED_PREFIXES = ['/assets/db1/', '/assets/db2/'];

function isLocalhostHost(host) {
  return host === 'localhost'
    || host.startsWith('localhost:')
    || host === '127.0.0.1'
    || host.startsWith('127.0.0.1:');
}

async function checkRateLimit(env, ip) {
  try {
    const id = env.RATE_LIMITER.idFromName(`ip:${ip}`);
    const stub = env.RATE_LIMITER.get(id);
    const resp = await stub.fetch('https://internal/check');
    return await resp.json();
  } catch (err) {
    // If the DO has trouble, do not block traffic — fail open.
    return { allowed: true, minute: 0, hour: 0, alerted: false, alreadyNotified: false, error: String(err) };
  }
}

async function shouldAlert(env, ip, kind) {
  // Ask the DO whether we've already fired this alert kind for this IP
  // in the current hour. Used to keep hotlink alerts to one per hour
  // per IP so a 1000-request scrape doesn't spam Telegram.
  try {
    const id = env.RATE_LIMITER.idFromName(`ip:${ip}`);
    const stub = env.RATE_LIMITER.get(id);
    const resp = await stub.fetch('https://internal/alert?k=' + encodeURIComponent(kind));
    const j = await resp.json();
    return !!j.shouldAlert;
  } catch (_) {
    return true;  // fail open: prefer to alert than miss it
  }
}

async function sendTelegramAlert(env, message) {
  // Always log to Cloudflare's observability stream first.
  console.log('[ALERT]', message);
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;
  try {
    await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TG_CHAT_ID,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
  } catch (_) {
    // Alerting must never block the response path.
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const isProtected = PROTECTED_PREFIXES.some(p => path.startsWith(p));

      if (isProtected) {
        const referer = request.headers.get('referer');
        const ip = request.headers.get('cf-connecting-ip') || 'unknown';

        // 1. Hotlink check — empty Referer (direct nav) is allowed; same
        // host or localhost is allowed; anything else is blocked.
        if (referer) {
          let allowed = false;
          try {
            const refHost = new URL(referer).host;
            if (refHost === url.host || isLocalhostHost(refHost)) allowed = true;
          } catch (_) {
            // Malformed Referer — treat as foreign.
          }
          if (!allowed) {
            ctx.waitUntil((async () => {
              if (await shouldAlert(env, ip, 'hotlink')) {
                await sendTelegramAlert(env,
                  `🚫 *Hotlink blocked*\nIP: \`${ip}\`\nReferer: \`${referer}\`\nPath: \`${path}\``);
              }
            })());
            return new Response(
              'Image hotlinking is not allowed. Visit ' + url.origin + ' to use these materials.\n',
              { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } },
            );
          }
        }

        // 2. Rate limit + 3. alerting via Durable Object.
        const rl = await checkRateLimit(env, ip);
        if (rl.alerted) {
          const ua = (request.headers.get('user-agent') || '').slice(0, 120);
          ctx.waitUntil(sendTelegramAlert(env,
            `⚠️ *Suspicious image traffic*\nIP: \`${ip}\`\nHour count: ${rl.hour}\nLast path: \`${path}\`\nUA: \`${ua}\``));
        }
        if (!rl.allowed) {
          return new Response('Rate limit exceeded. Try again later.\n', {
            status: 429,
            headers: {
              'content-type': 'text/plain; charset=utf-8',
              'cache-control': 'no-store',
              'retry-after': '60',
            },
          });
        }
      }

      return env.ASSETS.fetch(request);
    } catch (_err) {
      // Defensive: never let a script bug 500-out static delivery.
      return env.ASSETS.fetch(request);
    }
  },
};
