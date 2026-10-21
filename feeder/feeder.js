// Celtics feeder: hourly ESPN/nbaapi.com sync into SQL Server 2005 (the IIS version in ../iis-sql2005).
// Pulls the CURRENT roster live from ESPN, stats from nbaapi.com, injuries and schedule from ESPN, and
// writes them tagged with the NBA season (end-year, e.g. 2027 = the 2026-27 season). Runs on a host with
// internet access (Docker); the IIS/SQL 2005 server can stay offline. Hourly, plus once at start.
const sql = require('mssql');
const axios = require('axios');
const cron = require('node-cron');

const db = new sql.ConnectionPool({
  server: process.env.DB_HOST,
  port: 1433,
  user: process.env.DB_USER || 'celtics_feeder',
  password: process.env.DB_PASSWORD,
  database: 'roster_db',
  options: {
    tdsVersion: '7_2',                 // SQL Server 2005
    encrypt: false,
    trustServerCertificate: true,
    cryptoCredentialsDetails: { minVersion: 'TLSv1', ciphers: 'DEFAULT:@SECLEVEL=0' },  // SQL 2005 login = TLS 1.0
  },
  pool: { max: 2, min: 0, idleTimeoutMillis: 30000 },
});

const TEAM = 2;  // ESPN team id for the Boston Celtics
// The MVP ladder is maintained by hand (NBA.com Kia MVP Ladder); stats are pulled live per season.
const mvpLadder = ['Victor Wembanyama', 'Shai Gilgeous-Alexander', 'Nikola Jokic', 'Luka Doncic', 'Jaylen Brown'];

// NBA seasons are labelled by their end year. Oct-Dec belong to the season ending the NEXT year.
function currentSeasonEndYear(d = new Date()) { return (d.getMonth() + 1) >= 10 ? d.getFullYear() + 1 : d.getFullYear(); }
// Which seasons to sync this run. Default: the current season only (prior seasons stay as already stored).
const SEASONS = (process.env.NBA_SEASONS || String(process.env.NBA_SEASON || currentSeasonEndYear()))
  .split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);

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
const ZERO = { ppg: '0.0', rpg: '0.0', apg: '0.0', spg: '0.0', bpg: '0.0', mpg: '0.0', fgp: '0.0', tpp: '0.0', ftp: '0.0', gp: '0' };

// Current roster, live from ESPN (names, numbers, positions, ids and injuries).
async function fetchRoster() {
  const r = await axios.get(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${TEAM}/roster`,
    { timeout: 12000, headers: { Accept: 'application/json' } });
  const list = r.data?.athletes || [];
  return list.map(a => {
    const inj = (a.injuries || [])[0];
    let detail = inj ? (inj.longComment || inj.shortComment || inj.details?.type?.description || null) : null;
    if (detail) { detail = detail.replace(/<[^>]+>/g, '').trim(); if (detail.length > 200) detail = detail.slice(0, 197) + '...'; }
    return {
      num: a.jersey || '', name: a.displayName, pos: (a.position?.abbreviation) || '', espnId: String(a.id),
      injury: inj ? inj.status : null, injuryDetail: detail,
    };
  }).filter(p => p.name);
}

// Raw BOS regular-season totals from nbaapi, deduped by player (keep the row with the most games -
// drops any stray playoff/partial rows). Used for stats (current season) and as the roster (past seasons).
async function fetchBosTotals(season) {
  try {
    const res = await axios.get('https://api.server.nbaapi.com/api/playertotals',
      { params: { team: 'BOS', season, isPlayoff: false, pageSize: 100 }, timeout: 15000, headers: { Accept: 'application/json' } });
    const m = new Map();
    for (const p of res.data?.data || []) {
      const k = normalize(p.playerName), e = m.get(k);
      if (!e || parseInt(p.games || 0, 10) > parseInt(e.games || 0, 10)) m.set(k, p);
    }
    return [...m.values()];
  } catch (err) { console.error('  nbaapi.com fetch failed:', err.message); return []; }
}

// The player list for a season. Current season: live roster from ESPN + nbaapi stats.
// A completed (past) season: everyone who played for BOS that year, from nbaapi (real stats + games).
async function getSeasonPlayers(season) {
  if (season === currentSeasonEndYear()) {
    const roster = await fetchRoster();
    const statsMap = {};
    for (const p of await fetchBosTotals(season)) statsMap[normalize(p.playerName)] = extractStats(p);
    console.log(`  source: ESPN current roster (${roster.length}) + nbaapi stats (${Object.keys(statsMap).length})`);
    return roster.map(r => ({ ...r, stats: statsMap[normalize(r.name)] || ZERO }));
  }
  const rows = await fetchBosTotals(season);
  console.log(`  source: nbaapi completed season (${rows.length} players)`);
  return rows.map(p => ({ num: '', name: p.playerName, pos: p.position || '', espnId: '', injury: null, injuryDetail: null, stats: extractStats(p) }));
}

async function fetchMvpContenders(season) {
  let byName = new Map();
  try {
    const res = await axios.get('https://api.server.nbaapi.com/api/playertotals', { params: { season, pageSize: 500, page: 1 }, timeout: 15000 });
    for (const p of res.data?.data || []) {
      const k = normalize(p.playerName), e = byName.get(k);
      if (!e || parseInt(p.games || 0) > parseInt(e.games || 0)) byName.set(k, p);
    }
  } catch (err) { console.error('  MVP fetch failed:', err.message); }
  return mvpLadder.map((ladderName, i) => {
    const p = byName.get(normalize(ladderName)); const gp = parseInt(p?.games || 1, 10) || 1;
    return { rank: i + 1, name: p?.playerName || ladderName, team: p?.team || '—',
             ppg: p ? (parseFloat(p.points || 0) / gp).toFixed(1) : '—',
             rpg: p ? (parseFloat(p.totalRb || 0) / gp).toFixed(1) : '—',
             apg: p ? (parseFloat(p.assists || 0) / gp).toFixed(1) : '—' };
  });
}

async function fetchSchedule(season) {
  const r = await axios.get(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${TEAM}/schedule`,
    { params: { season }, timeout: 10000, headers: { Accept: 'application/json' } });
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

async function syncSeason(season) {
  console.log(`=== Sync season ${season} (${season - 1}-${String(season).slice(-2)}) @ ${new Date().toISOString()} ===`);
  // Mark this season's players stale; upserts clear the mark, then stragglers (players off the roster) are removed.
  await q('UPDATE dbo.players SET updated_at = NULL WHERE season = @season', { season });

  let roster = [];
  try { roster = await getSeasonPlayers(season); }
  catch (err) { console.error('  roster fetch failed, keeping existing rows:', err.message); return; }
  if (!roster.length) { console.error('  empty roster, skipping to avoid wiping the season'); return; }

  for (const p of roster) {
    const s = p.stats || ZERO;   // 0.0 early in a season before games are played
    await q(`UPDATE dbo.players SET num=@num, pos=@pos, espn_id=@espn, ppg=@ppg, rpg=@rpg, apg=@apg, spg=@spg, bpg=@bpg,
             fgp=@fgp, tpp=@tpp, ftp=@ftp, gp=@gp, mpg=@mpg, injury=@injury, injury_detail=@detail, updated_at=GETDATE()
             WHERE season=@season AND name=@name;
             IF @@ROWCOUNT = 0 INSERT dbo.players(season, num, name, pos, ppg, rpg, apg, spg, bpg, fgp, tpp, ftp, gp, mpg, injury, injury_detail, espn_id, updated_at)
             VALUES(@season, @num, @name, @pos, @ppg, @rpg, @apg, @spg, @bpg, @fgp, @tpp, @ftp, @gp, @mpg, @injury, @detail, @espn, GETDATE());`,
      { season, num: p.num, name: p.name, pos: p.pos, espn: p.espnId,
        ppg: s.ppg, rpg: s.rpg, apg: s.apg, spg: s.spg, bpg: s.bpg, fgp: s.fgp, tpp: s.tpp, ftp: s.ftp, gp: s.gp, mpg: s.mpg,
        injury: p.injury, detail: p.injuryDetail });
  }
  const del = await q('DELETE FROM dbo.players WHERE season=@season AND updated_at IS NULL', { season });
  console.log(`  players: ${roster.length} on roster${del.rowsAffected?.[0] ? `, removed ${del.rowsAffected[0]} no longer rostered` : ''}`);

  const mvp = await fetchMvpContenders(season);
  await q('DELETE FROM dbo.mvp_contenders WHERE season = @season', { season });
  for (const m of mvp) await q('INSERT dbo.mvp_contenders(season, [rank], name, team, ppg, rpg, apg) VALUES(@season, @rank, @name, @team, @ppg, @rpg, @apg)', { season, ...m });
  console.log(`  MVP: ${mvp.map(m => m.name).join(', ')}`);

  try {
    const sc = await fetchSchedule(season);
    // schedule_info.id is a plain (non-identity) PK; one row per season, so use the season as the id.
    await q(`UPDATE dbo.schedule_info SET played=@played, remaining=@remaining, playoff_start=@ps, last_games=@lg, updated_at=GETDATE() WHERE season=@season;
             IF @@ROWCOUNT = 0 INSERT dbo.schedule_info(id, season, played, remaining, playoff_start, last_games, updated_at) VALUES(@season, @season, @played, @remaining, @ps, @lg, GETDATE());`,
      { season, played: sc.played, remaining: sc.remaining, ps: sc.playoffStart, lg: JSON.stringify(sc.lastGames) });
    console.log(`  schedule: ${sc.played} played, ${sc.remaining} remaining, playoffs ${sc.playoffStart}`);
  } catch (err) { console.error('  schedule fetch failed:', err.message); }
  console.log('=== Sync complete ===');
}

async function sync() { for (const s of SEASONS) { try { await syncSeason(s); } catch (e) { console.error(`season ${s} failed:`, e.message); } } }

(async () => {
  console.log('Feeder syncing seasons:', SEASONS.join(', '));
  for (let i = 1; ; i++) {
    try { await db.connect(); console.log('Connected:', (await q('SELECT @@VERSION AS v')).recordset[0].v.split('\n')[0]); break; }
    catch (err) { console.error(`DB connect failed (${i}): ${err.message}`); await new Promise(r => setTimeout(r, Math.min(60, 5 * i) * 1000)); }
  }
  await sync();
  cron.schedule('0 * * * *', sync);
})();
