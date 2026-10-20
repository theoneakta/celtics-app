-- Fixed: removed the duplicate CREATE TABLE that was causing a startup crash.
-- The original file had two CREATE TABLE players statements; the second one
-- (without IF NOT EXISTS) would always fail with "relation already exists".
-- Also added the new columns (spg, bpg, fgp, tpp, ftp, gp, mpg, espn_id)
-- that server.js now writes to.

CREATE TABLE IF NOT EXISTS players (
    id       SERIAL PRIMARY KEY,
    num      VARCHAR(5),
    name     VARCHAR(100) UNIQUE,  -- UNIQUE required for ON CONFLICT upsert
    pos      VARCHAR(10),
    ppg      VARCHAR(10) DEFAULT '0.0',
    rpg      VARCHAR(10) DEFAULT '0.0',
    apg      VARCHAR(10) DEFAULT '0.0',
    spg      VARCHAR(10) DEFAULT '0.0',
    bpg      VARCHAR(10) DEFAULT '0.0',
    fgp      VARCHAR(10) DEFAULT '0.0',
    tpp      VARCHAR(10) DEFAULT '0.0',
    ftp      VARCHAR(10) DEFAULT '0.0',
    gp       VARCHAR(5)  DEFAULT '0',
    mpg      VARCHAR(10) DEFAULT '0.0',
    injury        VARCHAR(100),
    injury_detail VARCHAR(300),
    espn_id  VARCHAR(20)
);

-- Seed data: used as fallback if the ESPN sync hasn't run yet.
-- server.js will overwrite these with live values on startup.
INSERT INTO players (num, name, pos, ppg, rpg, apg, espn_id) VALUES
('7',  'Jaylen Brown',      'F/G', '29.5', '7.0', '4.7', '3917376'),
('0',  'Jayson Tatum',      'F',   '18.4', '10.8','5.4', '4065648'),
('9',  'Derrick White',     'G',   '17.4', '4.5', '5.5', '3062679'),
('11', 'Payton Pritchard',  'G',   '17.3', '4.2', '5.3', '4066349'),
('30', 'Sam Hauser',        'F',   '9.0',  '3.8', '1.4', '4066421'),
('88', 'Neemias Queta',     'C',   '9.9',  '8.4', '1.5', '4432165'),
('55', 'Baylor Scheierman', 'G',   '3.6',  '2.5', '0.9', '4431741'),
('27', 'Jordan Walsh',      'F',   '5.5',  '4.3', '0.8', '4683777'),
('52', 'Luka Garza',        'C',   '5.1',  '3.8', '0.6', '4278060'),
('28', 'Hugo González',     'F',   '3.9',  '3.4', '0.6', '5105088'),
('13', 'Ron Harper Jr.',    'F',   '6.2',  '3.8', '0.9', '4432805')
ON CONFLICT (name) DO NOTHING;
-- MVP contenders: wiped and re-seeded on every sync
CREATE TABLE IF NOT EXISTS mvp_contenders (
    id    SERIAL PRIMARY KEY,
    rank  INT,
    name  VARCHAR(100),
    team  VARCHAR(10),
    ppg   VARCHAR(10),
    rpg   VARCHAR(10),
    apg   VARCHAR(10)
);