// Shared wheel state — Upstash Redis (free tier) via REST.
// Vercel env vars needed:
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN  (from upstash.com console)
//   HOST_PASS  (your host passcode — only requests carrying it can write)
const KEY = 'grove-wheel:v1';
const REQ_KEY = 'grove-wheel:requests';
const CHK_KEY = 'grove-wheel:checkins';
const s80 = v => String(v ?? '').slice(0, 80);
const n0 = v => Math.min(Math.max(parseInt(v, 10) || 0, 0), 10000);

export default async function handler(req, res) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return res.status(500).json({ error: 'Storage not configured' });

  const cmd = async (arr) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(arr),
    });
    return r.json();
  };
  const getRequests = async () => {
    const j = await cmd(['GET', REQ_KEY]);
    return j.result ? JSON.parse(j.result) : [];
  };
  const getCheckins = async () => {
    const j = await cmd(['GET', CHK_KEY]);
    return j.result ? JSON.parse(j.result) : [];
  };

  if (req.method === 'GET') {
    // ?auth=1 lets the client verify a host passcode without writing
    if (req.query.auth) {
      const ok = req.headers['x-host-pass'] === process.env.HOST_PASS;
      return res.status(ok ? 200 : 401).json({ ok });
    }
    const j = await cmd(['GET', KEY]);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      value: j.result ? JSON.parse(j.result) : null,
      requests: await getRequests(),
      checkins: await getCheckins(),
    });
  }

  if (req.method === 'POST') {
    // Public: a holder activates their entry (like + repost check-in)
    if (req.query.checkin) {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const a = String(b.a || '').toLowerCase();
      const h = s80(b.h).replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '');
      if (!/^0x[a-f0-9]{40}$/.test(a) || !h) return res.status(400).json({ error: 'Invalid wallet or handle' });
      const list = await getCheckins();
      if (list.length >= 5000) return res.status(429).json({ error: 'Check-in list full' });
      const ex = list.find((c) => c.a === a);
      if (ex) { ex.h = h; ex.ts = Date.now(); }
      else list.push({ a, h, ts: Date.now() });
      await cmd(['SET', CHK_KEY, JSON.stringify(list)]);
      return res.status(200).json({ ok: true, checkins: list });
    }
    // Public: a community submits a collab request (no passcode needed)
    if (req.query.request) {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const entry = {
        id: Date.now(),
        name: s80(b.name), contact: s80(b.contact), note: s80(b.note),
        g: n0(b.g), f: n0(b.f), o: n0(b.o),
      };
      if (!entry.name || !entry.contact) return res.status(400).json({ error: 'Missing fields' });
      const list = await getRequests();
      if (list.length >= 200) return res.status(429).json({ error: 'Request queue full' });
      list.push(entry);
      await cmd(['SET', REQ_KEY, JSON.stringify(list)]);
      // Optional: ping Discord so the team knows instantly
      if (process.env.DISCORD_WEBHOOK_URL) {
        try {
          await fetch(process.env.DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content:
                `🌱 **New collab request on the Bonsai Wheel**\n` +
                `**Community:** ${entry.name}\n` +
                `**Contact:** ${entry.contact}\n` +
                `**Spots offered:** ${entry.g} Guaranteed · ${entry.f} FCFS · ${entry.o} 1:1` +
                (entry.note ? `\n**Note:** ${entry.note}` : ''),
            }),
          });
        } catch (e) { /* notification failure shouldn't block the request */ }
      }
      return res.status(200).json({ ok: true, requests: list });
    }

    // Everything below requires the host passcode
    if (req.headers['x-host-pass'] !== process.env.HOST_PASS)
      return res.status(401).json({ error: 'Wrong host passcode' });

    // Host removes a collab request
    if (req.query.reqdel) {
      const id = parseInt(req.query.reqdel, 10);
      const list = (await getRequests()).filter((r) => r.id !== id);
      await cmd(['SET', REQ_KEY, JSON.stringify(list)]);
      return res.status(200).json({ ok: true, requests: list });
    }

    // Host clears all check-ins (fresh gate for the next giveaway)
    if (req.query.chkclear) {
      await cmd(['SET', CHK_KEY, '[]']);
      return res.status(200).json({ ok: true, checkins: [] });
    }

    // Host saves wheel state
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (body.length > 2_000_000) return res.status(413).json({ error: 'State too large' });
    await cmd(['SET', KEY, body]);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
