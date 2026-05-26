// Cloudflare Durable Object: per-IP rate limiter for /assets/db*.
//
// One DO instance per IP (id = `ip:<ip>`). Stores two sliding-window
// counters in DO SQLite storage (free tier):
//   m:<minute_epoch>  — requests in this calendar minute
//   h:<hour_epoch>    — requests in this calendar hour
//   a:<hour_epoch>    — boolean: hourly-threshold alert already fired
// Old keys are pruned opportunistically when a new minute starts.
//
// On each /check call we increment both counters and return:
//   allowed     — false when the per-minute count is at/above the cap
//                 (Worker translates to HTTP 429)
//   alerted     — true the first time the hour count crosses the
//                 alert threshold (Worker fires Telegram once per hour)
//   minute,hour — current counter values for context

const PER_MIN_LIMIT = 50;        // requests/min before 429
const PER_HOUR_ALERT = 100;      // requests/hour before alert fires
const KEEP_MIN_WINDOWS = 2;      // last N minute keys to retain
const KEEP_HOUR_WINDOWS = 2;     // last N hour keys to retain

export class RateLimiter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    // Worker calls this DO with two URLs:
    //   /check     — increment counters and return rate-limit decision
    //   /alert?k=hotlink  — return whether a hotlink alert should fire
    //                       (once per hour per IP); never blocks traffic
    const url = new URL(request.url);
    if (url.pathname === '/alert') {
      return this.alertOnce(url.searchParams.get('k') || 'misc');
    }
    return this.check();
  }

  async alertOnce(kind) {
    // Dedup any custom alert kind (e.g. "hotlink") to once per hour per
    // IP per kind. Without this, a scraper hitting 100 hotlink-blocked
    // URLs in a row would fire 100 Telegram messages.
    const hourWin = Math.floor(Date.now() / 3600000);
    const key = `n:${kind}:${hourWin}`;
    const already = await this.state.storage.get(key);
    if (already) {
      return new Response(JSON.stringify({ shouldAlert: false }), { headers: { 'content-type': 'application/json' } });
    }
    await this.state.storage.put(key, true);
    return new Response(JSON.stringify({ shouldAlert: true }), { headers: { 'content-type': 'application/json' } });
  }

  async check() {
    const now = Date.now();
    const minWin = Math.floor(now / 60000);
    const hourWin = Math.floor(now / 3600000);
    const minKey = `m:${minWin}`;
    const hourKey = `h:${hourWin}`;
    const alertedKey = `a:${hourWin}`;

    const minCount = (await this.state.storage.get(minKey)) || 0;
    const hourCount = (await this.state.storage.get(hourKey)) || 0;
    const alreadyNotified = (await this.state.storage.get(alertedKey)) || false;

    const allowed = minCount < PER_MIN_LIMIT;
    let alerted = false;
    let newMin = minCount;
    let newHour = hourCount;

    if (allowed) {
      newMin = minCount + 1;
      newHour = hourCount + 1;
      await this.state.storage.put(minKey, newMin);
      await this.state.storage.put(hourKey, newHour);

      if (newHour >= PER_HOUR_ALERT && !alreadyNotified) {
        alerted = true;
        await this.state.storage.put(alertedKey, true);
      }

      // Light cleanup at start of each new minute. Keeps storage small;
      // free tier can handle many writes but we don't need history.
      if (newMin === 1) {
        const all = await this.state.storage.list();
        const drops = [];
        for (const k of all.keys()) {
          if (k.startsWith('m:') && parseInt(k.slice(2), 10) < minWin - KEEP_MIN_WINDOWS) drops.push(k);
          if (k.startsWith('h:') && parseInt(k.slice(2), 10) < hourWin - KEEP_HOUR_WINDOWS) drops.push(k);
          if (k.startsWith('a:') && parseInt(k.slice(2), 10) < hourWin - KEEP_HOUR_WINDOWS) drops.push(k);
          // Cleanup hotlink-dedup keys: n:<kind>:<hourWin>
          if (k.startsWith('n:')) {
            const parts = k.split(':');
            if (parts.length === 3 && parseInt(parts[2], 10) < hourWin - KEEP_HOUR_WINDOWS) drops.push(k);
          }
        }
        if (drops.length) await this.state.storage.delete(drops);
      }
    }

    return new Response(JSON.stringify({
      allowed,
      minute: newMin,
      hour: newHour,
      alerted,
      alreadyNotified,
    }), { headers: { 'content-type': 'application/json' } });
  }
}
