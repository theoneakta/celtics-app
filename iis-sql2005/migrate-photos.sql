-- Adds a headshot URL column to players. Idempotent. Run after migrate-teams.sql.
USE roster_db;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.players') AND name = 'photo')
    ALTER TABLE dbo.players ADD photo VARCHAR(200) NULL;
GO
