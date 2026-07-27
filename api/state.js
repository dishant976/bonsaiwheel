// Bonsai Wheel shared state — Upstash Redis via REST.
// Vercel env vars required:
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN  (Upstash console → REST API)
//   HOST_PASS            (host passcode — only requests carrying it can write state)
//   DISCORD_WEBHOOK_URL  (optional — pings Discord on new collab requests)
const KEY = 'grove-wheel:v1';
const REQ_KEY = 'grove-wheel:requests';
const CHK_KEY = 'grove-wheel:chk-hash'; // hash: wallet → {h, ts}; atomic per wallet

const s80 = (v) => String(v == null ? '' : v).slice(0, 80);
const n0 = (v) => Math.min(Math.max(parseInt(v, 10) || 0, 0), 10000);
const safeParse = (v, fallback) => {
  try { return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
};

module.exports = async function handler(req, res) {
  try {
    // Tolerate accidentally-quoted env values (e.g. pasted from a .env file)
    const clean = (v) => String(v || '').trim().replace(/^["']+|["']+$/g, '');
    const url = clean(process.env.UPSTASH_REDIS_REST_URL);
    const token = clean(process.env.UPSTASH_REDIS_REST_TOKEN);
    if (!url || !token) return res.status(500).json({ error: 'Storage not configured' });

    const cmd = async (arr) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        body: JSON.stringify(arr),
      });
      return r.json();
    };
    const getKey = async (k, fallback) => {
      const j = await cmd(['GET', k]);
      return safeParse(j && j.result, fallback);
    };
    // Check-ins live in a hash: HGETALL → [field, value, field, value, ...]
    const getCheckins = async () => {
      const j = await cmd(['HGETALL', CHK_KEY]);
      const arr = j && Array.isArray(j.result) ? j.result : [];
      const list = [];
      for (let i = 0; i + 1 < arr.length; i += 2) {
        const meta = safeParse(arr[i + 1], {});
        list.push({ a: arr[i], h: meta.h || '', ts: meta.ts || 0 });
      }
      return list;
    };

    if (req.method === 'GET') {
      // ?auth=1 → verify host passcode without writing
      if (req.query && req.query.auth) {
        const ok = req.headers['x-host-pass'] === process.env.HOST_PASS;
        return res.status(ok ? 200 : 401).json({ ok });
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        value: await getKey(KEY, null),
        requests: await getKey(REQ_KEY, []),
        checkins: await getCheckins(),
      });
    }

    if (req.method === 'POST') {
      const q = req.query || {};

      // Public: holder activates their entry (like + repost check-in)
      if (q.checkin) {
        const b = typeof req.body === 'string' ? safeParse(req.body, {}) : (req.body || {});
        const a = String(b.a || '').toLowerCase();
        const h = s80(b.h).replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '');
        if (!/^0x[a-f0-9]{40}$/.test(a) || !h) return res.status(400).json({ error: 'Invalid wallet or handle' });
        const lenJ = await cmd(['HLEN', CHK_KEY]);
        if ((lenJ && lenJ.result || 0) >= 5000) return res.status(429).json({ error: 'Check-in list full' });
        // HSET is atomic per wallet — concurrent activations can never wipe each other
        await cmd(['HSET', CHK_KEY, a, JSON.stringify({ h, ts: Date.now() })]);
        const list = await getCheckins();
        return res.status(200).json({ ok: true, checkins: list });
      }

      // Public: a community submits a collab request
      if (q.request) {
        const b = typeof req.body === 'string' ? safeParse(req.body, {}) : (req.body || {});
        const entry = {
          id: Date.now(),
          name: s80(b.name), contact: s80(b.contact), note: s80(b.note),
          g: n0(b.g), f: n0(b.f), o: n0(b.o),
        };
        if (!entry.name || !entry.contact) return res.status(400).json({ error: 'Missing fields' });
        const list = await getKey(REQ_KEY, []);
        if (list.length >= 200) return res.status(429).json({ error: 'Request queue full' });
        list.push(entry);
        await cmd(['SET', REQ_KEY, JSON.stringify(list)]);
        if (process.env.DISCORD_WEBHOOK_URL) {
          try {
            await fetch(process.env.DISCORD_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content:
                  '🌱 **New collab request on the Bonsai Wheel**\n' +
                  '**Community:** ' + entry.name + '\n' +
                  '**Contact:** ' + entry.contact + '\n' +
                  '**Spots offered:** ' + entry.g + ' Guaranteed · ' + entry.f + ' FCFS · ' + entry.o + ' 1:1' +
                  (entry.note ? '\n**Note:** ' + entry.note : ''),
              }),
            });
          } catch (e) { /* notification failure must not block the request */ }
        }
        return res.status(200).json({ ok: true, requests: list });
      }

      // Everything below requires the host passcode
      if (req.headers['x-host-pass'] !== process.env.HOST_PASS)
        return res.status(401).json({ error: 'Wrong host passcode' });

      // Host removes a collab request
      if (q.reqdel) {
        const id = parseInt(q.reqdel, 10);
        const list = (await getKey(REQ_KEY, [])).filter((r) => r.id !== id);
        await cmd(['SET', REQ_KEY, JSON.stringify(list)]);
        return res.status(200).json({ ok: true, requests: list });
      }

      // Host clears all check-ins
      if (q.chkclear) {
        await cmd(['DEL', CHK_KEY]);
        return res.status(200).json({ ok: true, checkins: [] });
      }

      // Host saves wheel state
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!body || body.length > 2000000) return res.status(413).json({ error: 'Bad state payload' });
      await cmd(['SET', KEY, body]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    // Never crash the function — always answer with the reason
    return res.status(500).json({ error: 'Server error: ' + (err && err.message ? err.message : 'unknown') });
  }
};
