// Celtics roster API for IIS 7.5 / ASP.NET 2.0-3.5 (compiled on the fly from App_Code; C# 2.0 syntax).
// Same JSON shapes as the original Node/Express backend. Read-only: the feeder on .8 writes the data.
using System;
using System.Collections.Generic;
using System.Configuration;
using System.Data.SqlClient;
using System.Web;
using System.Web.Script.Serialization;

namespace Celtics
{
    public abstract class JsonHandler : IHttpHandler
    {
        public bool IsReusable { get { return true; } }
        protected abstract object Build();

        public void ProcessRequest(HttpContext ctx)
        {
            ctx.Response.ContentType = "application/json";
            ctx.Response.Cache.SetCacheability(HttpCacheability.NoCache);
            JavaScriptSerializer js = new JavaScriptSerializer();
            try { ctx.Response.Write(js.Serialize(Build())); }
            catch (Exception e)
            {
                ctx.Response.StatusCode = 500;
                ctx.Response.TrySkipIisCustomErrors = true;   // keep our JSON instead of IIS's HTML error page
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["error"] = e.Message;
                ctx.Response.Write(js.Serialize(err));
            }
        }

        protected static List<Dictionary<string, object>> Query(string sql)
        {
            List<Dictionary<string, object>> rows = new List<Dictionary<string, object>>();
            using (SqlConnection cn = new SqlConnection(ConfigurationManager.ConnectionStrings["roster"].ConnectionString))
            using (SqlCommand cmd = new SqlCommand(sql, cn))
            {
                cn.Open();
                using (SqlDataReader r = cmd.ExecuteReader())
                {
                    while (r.Read())
                    {
                        Dictionary<string, object> row = new Dictionary<string, object>();
                        for (int i = 0; i < r.FieldCount; i++)
                            row[r.GetName(i)] = r.IsDBNull(i) ? null : r.GetValue(i);
                        rows.Add(row);
                    }
                }
            }
            return rows;
        }
    }

    public class RosterHandler : JsonHandler
    {
        protected override object Build()
        {
            return Query("SELECT id, num, name, pos, ppg, rpg, apg, spg, bpg, fgp, tpp, ftp, gp, mpg, injury, injury_detail, espn_id " +
                         "FROM dbo.players ORDER BY CAST(num AS INT)");
        }
    }

    public class MvpHandler : JsonHandler
    {
        protected override object Build()
        {
            return Query("SELECT id, [rank], name, team, ppg, rpg, apg FROM dbo.mvp_contenders ORDER BY [rank]");
        }
    }

    public class ScheduleHandler : JsonHandler
    {
        protected override object Build()
        {
            List<Dictionary<string, object>> rows = Query("SELECT played, remaining, playoff_start, last_games, updated_at FROM dbo.schedule_info WHERE id = 1");
            Dictionary<string, object> o = new Dictionary<string, object>();
            if (rows.Count == 0) throw new Exception("schedule not synced yet");
            Dictionary<string, object> s = rows[0];
            o["played"] = s["played"];
            o["remaining"] = s["remaining"];
            o["playoffStart"] = s["playoff_start"] ?? "TBD";
            o["lastGames"] = s["last_games"] == null ? new object[0] : new JavaScriptSerializer().DeserializeObject((string)s["last_games"]);
            o["updatedAt"] = s["updated_at"];
            return o;
        }
    }

    public class HealthHandler : JsonHandler
    {
        protected override object Build()
        {
            List<Dictionary<string, object>> r = Query("SELECT @@VERSION AS sql_version, (SELECT COUNT(*) FROM dbo.players) AS players, " +
                "(SELECT MAX(updated_at) FROM dbo.schedule_info) AS last_sync");
            r[0]["iis"] = HttpContext.Current.Request.ServerVariables["SERVER_SOFTWARE"];
            r[0]["aspnet"] = Environment.Version.ToString();
            return r[0];
        }
    }
}
