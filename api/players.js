// Save King Liam: players and high scores.
// Storage is Upstash Redis (Vercel Storage → Upstash for Redis). Vercel adds the
// connection settings to the project as environment variables when you connect it.
//
// GET  /api/players            → { players: [{ name, high, loop, done }] } best first
// GET  /api/players?name=Liam  → { player: { name, best, high, save, updated } | null }
// POST /api/players            → body { name, save, best, updated } → { player }

const KEY = 'skl:players';
const HEROES = ['crossbow', 'sniper', 'hammer', 'weight', 'axman', 'beard', 'will', 'fill', 'liam'];
const DIFFS = ['easy', 'normal', 'hard', 'impossible'];
const LEVELS = 5;

function config() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function redis(cfg, command) {
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

const cleanName = (n) => String(n || '').replace(/[^\p{L}\p{N} '_-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(v) || 0)));

function cleanSave(s) {
  s = s && typeof s === 'object' ? s : {};
  return {
    done: int(s.done, 0, LEVELS),
    diff: DIFFS.includes(s.diff) ? s.diff : 'easy',
    owned: Array.isArray(s.owned) ? [...new Set(s.owned.filter((h) => HEROES.includes(h)))] : [],
    loop: int(s.loop, 0, 999),
    rev: int(s.rev, 0, 1e6),
  };
}

// A save is "further along" if it was reset more recently, then by adventure number, then by levels done.
function compare(a, b) {
  const x = [a.rev, a.loop, a.done], y = [b.rev, b.loop, b.done];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const cfg = config();
  if (!cfg) return res.status(503).json({ error: 'not_configured' });
  try {
    if (req.method === 'GET') {
      if (req.query && req.query.name) {
        const raw = await redis(cfg, ['HGET', KEY, cleanName(req.query.name).toLowerCase()]);
        return res.status(200).json({ player: raw ? JSON.parse(raw) : null });
      }
      const all = (await redis(cfg, ['HGETALL', KEY])) || [];
      const players = [];
      for (let i = 0; i + 1 < all.length; i += 2) {
        try {
          const p = JSON.parse(all[i + 1]);
          players.push({ name: p.name, high: p.high || 0, loop: (p.save && p.save.loop) || 0, done: (p.save && p.save.done) || 0 });
        } catch (e) { /* skip a bad row */ }
      }
      players.sort((a, b) => b.high - a.high);
      return res.status(200).json({ players: players.slice(0, 100) });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const name = cleanName(body.name);
      if (!name) return res.status(400).json({ error: 'name_required' });
      const key = name.toLowerCase();
      const oldRaw = await redis(cfg, ['HGET', KEY, key]);
      const old = oldRaw ? JSON.parse(oldRaw) : null;

      // Keep the best score ever made on each level.
      const best = [];
      const ob = (old && old.best) || [], nb = Array.isArray(body.best) ? body.best : [];
      for (let i = 0; i < LEVELS; i++) best[i] = Math.max(int(ob[i], 0, 1e8), int(nb[i], 0, 1e8));
      const high = best.reduce((a, x) => a + x, 0);

      // Keep whichever saved game is further along.
      let save = cleanSave(body.save);
      if (old && old.save) {
        const c = compare(cleanSave(old.save), save);
        if (c > 0 || (c === 0 && (old.updated || 0) > (Number(body.updated) || 0))) save = cleanSave(old.save);
      }
      const player = { name: (old && old.name) || name, best, high, save, updated: Date.now() };
      await redis(cfg, ['HSET', KEY, key, JSON.stringify(player)]);
      return res.status(200).json({ player });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'storage_error' });
  }
};
