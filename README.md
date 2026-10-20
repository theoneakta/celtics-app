# Celtics Hub

A small Boston Celtics tracker. It shows the roster with live per-game stats and injuries, the Kia MVP ladder, and the season schedule with recent results. The data comes from [nbaapi.com](https://api.server.nbaapi.com) and ESPN's public site API, refreshed hourly.

The same app ships in two deployments:

| Folder | Stack |
|---|---|
| [`docker/`](docker) | The original app: nginx (static page), Node.js/Express API with an hourly sync, PostgreSQL 15 |
| [`iis-sql2005/`](iis-sql2005) | A port for a legacy Windows lab: **IIS 7.5 + ASP.NET 3.5 (C# 2.0) + SQL Server 2005** on Windows Server 2008 R2 |
| [`feeder/`](feeder) | The hourly sync from the Node backend, rewritten to write to SQL Server 2005, so the legacy server never needs internet access |

## docker/ (original)

```sh
cd docker
cp .env.example .env        # set DB_PASSWORD
docker compose up -d --build
```

- Page: `http://<host>/`
- API: `http://<host>:3000/api/roster`, `/api/mvp`, `/api/schedule`, `POST /api/sync`
- The page calls the API on port 3000 of the host it was loaded from.

## iis-sql2005/ (legacy port)

The page talks to the same JSON API, served by `IHttpHandler`s that ASP.NET compiles on the fly from `App_Code/Api.cs`. No Visual Studio is needed.

- **Database:** `roster_db.sql` creates the database (`players`, `mvp_contenders`, `schedule_info`), seeds the roster and creates two logins:
  - the IIS app pool identity `IIS APPPOOL\Celtics`, read-only through Windows auth, so there is no password in `web.config`;
  - `celtics_feeder`, a SQL login with write access for the feeder.
- **Setup:** `setup-iis.ps1` installs IIS with ASP.NET, creates the `Celtics` app pool (.NET 2.0, integrated) and site on port 80, runs the SQL script and opens port 80 for the local subnet.
- **Requirements:** Windows Server 2008 R2 SP1 with .NET 3.5.1 and SQL Server 2005 SP4. SQL must be in mixed mode, with TCP enabled on 1433.
- **Gotchas found along the way:**
  - The default `Restricted` execution policy blocks the WebAdministration module. The script sets `RemoteSigned`.
  - On IIS 7.5, `Get-Website -Name` ignores the name. Use `Test-Path IIS:\Sites\<name>`.
  - SQL 2005 has no `MERGE` or `ON CONFLICT`. Upserts are `UPDATE` followed by `IF @@ROWCOUNT = 0 INSERT`.

## feeder/

```sh
cd feeder
cp .env.example .env        # DB_HOST = the SQL Server 2005 box, DB_PASSWORD = celtics_feeder's password
docker compose up -d --build
```

The fetch and mapping code is the same as `docker/backend/server.js`. `/api/schedule`, which the Node app computed live, is stored in `schedule_info`.

SQL Server 2005 only supports TLS 1.0 for the login handshake. The feeder's `tedious` driver is therefore set to `tdsVersion: '7_2'` and allows TLS 1.0 for that one connection (`minVersion: 'TLSv1'`, `SECLEVEL=0`).

## Notes

- The MVP ladder (`mvpLadder`) and the fallback stats are maintained by hand in the code.
- `mpg` holds nbaapi.com's `minutesPg`, which is a season total. The page doesn't display it.
- Windows Server 2008 R2 and SQL Server 2005 are long out of support. Run the legacy version isolated: no internet, and only the ports you need open.
