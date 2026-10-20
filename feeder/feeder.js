// Celtics feeder: the sync half of the original celtics-app backend (server.js), writing to SQL Server 2005
// instead of Postgres. Runs on a host with internet access (Docker);
// the IIS/SQL 2005 server can stay offline. Hourly, plus once at start. Fetch/mapping logic is unchanged from server.js.
const sql = require('mssql');
const axios = require('axios');
const cron = require('node-cron');

const db = new sql.ConnectionPool({
  server: process.env.DB_HOST,          // SQL Server 2005 host (see .env.example)
  port: 1433,
  user: process.env.DB_USER || 'celtics_feeder',
  password: process.env.DB_PASSWORD,
  database: 'roster_db',
  options: {
    tdsVersion: '7_2',                 // SQL Server 2005
    encrypt: false,                    // no channel encryption (LAN); the login packet still uses TLS 1.0 -
    trustServerCertificate: true,      // SQL 2005's self-signed SHA1/1024-bit cert and TLS 1.0 only,
    cryptoCredentialsDetails: { minVersion: 'TLSv1', ciphers: 'DEFAULT:@SECLEVEL=0' },  // so allow those here
  },
  pool: { max: 2, min: 0, idleTimeoutMillis: 30000 },
});

// ─── MASTER ROSTER / FALLBACKS / MVP LADDER (from server.js) ─────────────────
const masterRoster = [
  { num: "7",  name: "Jaylen Brown",       pos: "F/G", espnId: "3917376" },
  { num: "0",  name: "Jayson Tatum",       pos: "F",   espnId: "4065648" },
  { num: "9",  name: "Derrick White",      pos: "G",   espnId: "3062679" },
  { num: "11", name: "Payton Pritchard",   pos: "G",   espnId: "4066349" },
  { num: "30", name: "Sam Hauser",         pos: "F",   espnId: "4066421" },
  { num: "88", name: "Neemias Queta",      pos: "C",   espnId: "4432165" },
  { num: "55", name: "Baylor Scheierman",  pos: "G",   espnId: "4431741" },
  { num: "27", name: "Jordan Walsh",       pos: "F",   espnId: "4683777" },
  { num: "52", name: "Luka Garza",         pos: "C",   espnId: "4278060" },
  { num: "28", name: "Hugo González",      pos: "F",   espnId: "5105088" },
  { num: "13", name: "Ron Harper Jr.",     pos: "F",   espnId: "4432805" },
];
const fallbackStats = {
  "luka garza":   { ppg:"5.1", rpg:"3.8", apg:"0.6", spg:"0.2", bpg:"0.5", fgp:"54.0", tpp:"0.0", ftp:"80.0", gp:"22", mpg:"11.0" },
  "hugo gonzalez":{ ppg:"3.9", rpg:"3.4", apg:"0.6", spg:"0.5", bpg:"0.3", fgp:"41.0", tpp:"34.0",ftp:"72.0", gp:"47", mpg:"14.0" },
  "ron harper jr":{ ppg:"6.2", rpg:"3.8", apg:"0.9", spg:"0.6", bpg:"0.3", fgp:"50.0", tpp:"38.0",ftp:"76.0", gp:"38", mpg:"14.5" },
};
const mvpLadder = ['Victor Wembanyama', 'Shai Gilgeous-Alexander', 'Nikola Jokic', 'Luka Doncic', 'Jaylen Brown'];
const SEASON = parseInt(process.env.NBA_SEASON || '2026', 10);

function normalize(name) {
  return (name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
function extractStats(p) {
  const gp = parseInt(p.games || 1, 10) || 1;
  const avg = (v) => (parseFloat(v || 0) / gp).toFixed(1);
  const fmt = (v) => parseFloat(v || 0).toFixed(1);
  const pct = (v) => (parseFloat(v || 0) * 100).toFixed(1);
  return { ppg: avg(p.points), rpg: avg(p.totalRb), apg: avg(p.assists), spg: avg(p.steals), bpg: avg(p.blocks),
           mpg: fmt(p.minutesPg), fgp: pct(p.fieldPercent), tpp: pct(p.threePercent), ftp: pct(p.ftPercent), gp: String(p.games || 0) };
}

async function fetchNbaApiStats() {
  const statsMap = {};
  try {
    const res = await axios.get('https://api.server.nbaapi.com/api/playertotals',
      { params: { team: 'BOS', season: SEASON, isPlayoff: false, pageSize: 50 }, timeout: 15000, headers: { Accept: 'application/json' } });
    const players = res.data?.data || [];
    console.log(`  nbaapi.com returned ${players.length} players`);
    for (const p of players) statsMap[normalize(p.playerName)] = extractStats(p);
  } catch (err) { console.error('  nbaapi.com fetch failed:', err.message); }
  return statsMap;
}

async function fetchInjuryMap() {
  const injuryMap = {};
  try {
    const r = await axios.get('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/2/roster', { timeout: 10000, headers: { Accept: 'application/json' } });
    for (const athlete of (r.data?.athletes || []).filter(a => a.injuries?.length > 0)) {
      const inj = athlete.injuries[0];
      let detail = inj.longComment || inj.shortComment || inj.description || inj.type?.description || null;
      if (!detail) {
        try {
          const a = await axios.get(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/athletes/${athlete.id}`, { timeout: 8000 });
          const ai = a.data?.athlete?.injuries?.[0];
          detail = ai?.longComment || ai?.shortComment || ai?.description || ai?.details?.type?.description || null;
        } catch (_) { /* status only */ }
      }
      if (detail) { detail = detail.replace(/<[^>]+>/g, '').trim(); if (detail.length > 200) detail = detail.slice(0, 197) + '...'; }
      injuryMap[athlete.id] = { status: inj.status, detail };
    }
    console.log(`  ESPN injury map: ${Object.keys(injuryMap).length} player(s)`);
  } catch (err) { console.error('  ESPN injury fetch failed:', err.message); }
  return injuryMap;
}

async function fetchMvpContenders() {
  try {
    const res = await axios.get('https://api.server.nbaapi.com/api/playertotals', { params: { season: SEASON, pageSize: 500, page: 1 }, timeout: 15000 });
    const byName = new Map();
    for (const p of res.data?.data || []) {
      const k = normalize(p.playerName), e = byName.get(k);
      if (!e || parseInt(p.games || 0) > parseInt(e.games || 0)) byName.set(k, p);
    }
    return mvpLadder.map((ladderName, i) => {
      const p = byName.get(normalize(ladderName)); const gp = parseInt(p?.games || 1, 10) || 1;
      return { rank: i + 1, name: p?.playerName || ladderName, team: p?.team || '—',
               ppg: p ? (parseFloat(p.points || 0) / gp).toFixed(1) : '—',
               rpg: p ? (parseFloat(p.totalRb || 0) / gp).toFixed(1) : '—',
               apg: p ? (parseFloat(p.assists || 0) / gp).toFixed(1) : '—' };
    });
  } catch (err) { console.error('  MVP fetch failed:', err.message); return []; }
}

// /api/schedule was computed live in server.js; here it's computed hourly and stored in schedule_info
async function fetchSchedule() {
  const r = await axios.get('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/2/schedule',
    { params: { season: SEASON }, timeout: 10000, headers: { Accept: 'application/json' } });
  const events = r.data?.events || [];
  const finished = events.filter(e => e.competitions?.[0]?.status?.type?.completed);
  const upcoming = events.filter(e => !e.competitions?.[0]?.status?.type?.completed);
  const lastGames = finished.slice(-3).map(e => {
    const comp = e.competitions[0];
    const celtics = comp.competitors.find(c => c.team?.abbreviation === 'BOS');
    const opponent = comp.competitors.find(c => c.team?.abbreviation !== 'BOS');
    const cs = String(celtics?.score?.displayValue ?? celtics?.score ?? '0');
    const os = String(opponent?.score?.displayValue ?? opponent?.score ?? '0');
    return { result: parseInt(cs) > parseInt(os) ? 'W' : 'L', score: `${cs}-${os}`, opp: opponent?.team?.abbreviation || '?', isHome: celtics?.homeAway === 'home' };
  });
  let playoffStart = null;
  for (let i = 0; i < upcoming.length - 1; i++) {
    const a = new Date(upcoming[i].date), b = new Date(upcoming[i + 1].date);
    if ((b - a) > 10 * 24 * 60 * 60 * 1000) { playoffStart = b.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase(); break; }
  }
  return { played: finished.length, remaining: upcoming.length, playoffStart: playoffStart || 'TBD', lastGames };
}

const q = (text, params = {}) => { const r = db.request(); for (const [k, v] of Object.entries(params)) r.input(k, v); return r.query(text); };

async function sync() {
  console.log(`=== Sync ${new Date().toISOString()} ===`);
  try {
    for (const p of masterRoster) {   // upsert (SQL 2005 has no MERGE / ON CONFLICT)
      await q(`UPDATE dbo.players SET num=@num, pos=@pos, espn_id=@espn WHERE name=@name;
               IF @@ROWCOUNT = 0 INSERT INTO dbo.players (num, name, pos, ppg, rpg, apg, espn_id) VALUES (@num, @name, @pos, '0.0', '0.0', '0.0', @espn);`,
              { num: p.num, name: p.name, pos: p.pos, espn: p.espnId });
    }
    const statsMap = await fetchNbaApiStats();
    const injuryMap = await fetchInjuryMap();
    for (const p of masterRoster) {
      const key = normalize(p.name), inj = injuryMap[p.espnId] || null;
      const stats = statsMap[key] || fallbackStats[key];
      if (stats) {
        await q(`UPDATE dbo.players SET ppg=@ppg, rpg=@rpg, apg=@apg, spg=@spg, bpg=@bpg, fgp=@fgp, tpp=@tpp, ftp=@ftp, gp=@gp, mpg=@mpg,
                 injury=@injury, injury_detail=@detail WHERE name=@name`,
                { ...stats, injury: inj ? inj.status : null, detail: inj ? inj.detail : null, name: p.name });
        console.log(`  ✓ ${p.name} [${statsMap[key] ? 'live' : 'fallback'}]: ${stats.ppg} PPG${inj ? ' | ⚠ ' + inj.status : ''}`);
      } else {
        console.log(`  ✗ ${p.name}: no stats`);
        if (inj) await q('UPDATE dbo.players SET injury=@i, injury_detail=@d WHERE name=@n', { i: inj.status, d: inj.detail, n: p.name });
      }
    }
    const mvp = await fetchMvpContenders();
    if (mvp.length) {
      await q('DELETE FROM dbo.mvp_contenders');
      for (const m of mvp) await q('INSERT INTO dbo.mvp_contenders ([rank], name, team, ppg, rpg, apg) VALUES (@rank, @name, @team, @ppg, @rpg, @apg)', m);
      console.log(`  MVP: ${mvp.map(m => m.name).join(', ')}`);
    }
    try {
      const s = await fetchSchedule();
      await q(`UPDATE dbo.schedule_info SET played=@played, remaining=@remaining, playoff_start=@ps, last_games=@lg, updated_at=GETDATE() WHERE id=1;
               IF @@ROWCOUNT = 0 INSERT INTO dbo.schedule_info (id, played, remaining, playoff_start, last_games, updated_at) VALUES (1, @played, @remaining, @ps, @lg, GETDATE());`,
              { played: s.played, remaining: s.remaining, ps: s.playoffStart, lg: JSON.stringify(s.lastGames) });
      console.log(`  schedule: ${s.played} played, ${s.remaining} remaining, playoffs ${s.playoffStart}`);
    } catch (err) { console.error('  schedule fetch failed:', err.message); }
    console.log('=== Sync complete ===');
  } catch (err) { console.error('Sync error:', err.message); }
}

(async () => {
  for (let i = 1; ; i++) {
    try { await db.connect(); const v = await q('SELECT @@VERSION AS v'); console.log('Connected:', v.recordset[0].v.split('\n')[0]); break; }
    catch (err) { console.error(`DB connect failed (${i}): ${err.message}`); await new Promise(r => setTimeout(r, Math.min(60, 5 * i) * 1000)); }
  }
  await sync();
  cron.schedule('0 * * * *', sync);
})();
