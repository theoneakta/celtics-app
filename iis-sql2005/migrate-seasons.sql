-- Adds a per-season dimension to an existing roster_db (SQL Server 2005). Idempotent; safe to re-run.
-- Existing rows (the first season loaded, 2025-26) are tagged season = 2026.
USE roster_db;
GO
-- players: season + updated_at, and a (season, name) uniqueness instead of (name)
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.players') AND name = 'season')
    ALTER TABLE dbo.players ADD season INT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.players') AND name = 'updated_at')
    ALTER TABLE dbo.players ADD updated_at DATETIME NULL;
GO
UPDATE dbo.players SET season = 2026 WHERE season IS NULL;
GO
IF EXISTS (SELECT 1 FROM sys.objects WHERE name = 'UQ_players_name' AND parent_object_id = OBJECT_ID('dbo.players'))
    ALTER TABLE dbo.players DROP CONSTRAINT UQ_players_name;
GO
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE name = 'UQ_players_season_name' AND parent_object_id = OBJECT_ID('dbo.players'))
    ALTER TABLE dbo.players ADD CONSTRAINT UQ_players_season_name UNIQUE (season, name);
GO
-- mvp_contenders: season
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.mvp_contenders') AND name = 'season')
    ALTER TABLE dbo.mvp_contenders ADD season INT NULL;
GO
UPDATE dbo.mvp_contenders SET season = 2026 WHERE season IS NULL;
GO
-- schedule_info: season (one row per season instead of the single id = 1 row)
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.schedule_info') AND name = 'season')
    ALTER TABLE dbo.schedule_info ADD season INT NULL;
GO
UPDATE dbo.schedule_info SET season = 2026 WHERE season IS NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_schedule_season' AND object_id = OBJECT_ID('dbo.schedule_info'))
    CREATE UNIQUE INDEX UX_schedule_season ON dbo.schedule_info(season);
GO
SELECT 'players' AS t, season, COUNT(*) AS n FROM dbo.players GROUP BY season
UNION ALL SELECT 'mvp', season, COUNT(*) FROM dbo.mvp_contenders GROUP BY season
UNION ALL SELECT 'schedule', season, COUNT(*) FROM dbo.schedule_info GROUP BY season
ORDER BY t, season;
GO
