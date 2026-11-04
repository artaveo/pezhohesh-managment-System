// Talks to the ZKTeco K50 through ZKTeco's own Standalone SDK (zkemkeeper.dll). It is a small
// 32-bit program of its own, installed next to the core API, because the SDK is a 32-bit COM
// library. The app keeps its own copy of the SDK (see "The SDK" below), so ZKAccess can be
// removed; until that copy exists the one ZKAccess registered is used. It reads one JSON request on stdin and writes one
// JSON answer on stdout:
//   { "ip": "...", "port": 4370, "machine": 1, "key": 0, "ops": [ { "op": "info" }, ... ] }
//   { "ok": true, "results": [ { "ok": true, ... }, ... ] }   or   { "ok": false, "error": "..." }
// Once the SDK loads, every answer also says which copy: "sdk": "app" or the file's path.
// { "sdk": "install", "from": "<folder or empty>" } copies the SDK into the app's folder and
// { "sdk": "status" } says which copy loads; neither reaches the device.
// Nothing here deletes a user or a finger; a member who should not come in is disabled.
//
// The device is small and gets stuck when a talk with it is cut off half way (it then stops
// answering the network until it is restarted). So every talk ends here, properly: the
// request carries a time "budget" in seconds, and once it is spent no new work starts and the
// long reads stop, the device is unlocked and the connection is closed. Writes lock the
// device with a timeout of its own (DisableDeviceWithTimeOut), so even a helper that is
// killed leaves a device that unlocks itself. Only one helper talks to the device at a time
// on this computer (a system-wide mutex), whichever copy of the app started it.
//
// Built with the C# compiler that ships with Windows (.NET Framework 4), which knows only
// C# 5: no $"" strings, no ?. and no `out var` here. See scripts/prepare-sidecar.mjs.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using ComTypes = System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Web.Script.Serialization;

static class K50Helper
{
    static dynamic zk;
    static int m;
    // When this talk has to be wrapping up (from the request's "budget").
    static DateTime deadline = DateTime.MaxValue;
    static bool Late() { return DateTime.UtcNow > deadline; }
    static int SecondsLeft() { return deadline == DateTime.MaxValue ? 600 : Math.Max(0, (int)(deadline - DateTime.UtcNow).TotalSeconds); }
    // The valid-date call differs between SDK versions; the first form the device takes is kept.
    static int? dateForm;

    [STAThread]
    static int Main()
    {
        Dictionary<string, object> req;
        try
        {
            // The request is plain ASCII (the app writes other letters as \u escapes).
            string text;
            using (var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)))
                text = reader.ReadToEnd();
            req = Json().Deserialize<Dictionary<string, object>>(text);
            if (req == null) throw new FormatException("empty request");
        }
        catch (Exception e)
        {
            return Answer(Obj("ok", false, "error", "bad_request", "detail", e.Message));
        }

        // Copying the SDK into the app's own folder happens before any copy of it is loaded.
        var sdk = Str(req, "sdk");
        if (sdk == "install")
        {
            try { return Answer(InstallSdk(Str(req, "from"))); }
            catch (Exception e) { return Answer(Obj("ok", false, "error", "sdk_copy_failed", "detail", e.Message)); }
        }
        LoadSdk();
        if (sdk == "status") return Answer(SdkStatus());
        if (zk == null) return Answer(Obj("ok", false, "error", "sdk_missing", "bits", IntPtr.Size * 8));

        try
        {
            return Answer(Run(req));
        }
        catch (Exception e)
        {
            return Answer(Obj("ok", false, "error", "exception", "detail", e.Message));
        }
    }

    static Dictionary<string, object> Run(Dictionary<string, object> req)
    {
        var budget = Int(req, "budget");
        if (budget > 0) deadline = DateTime.UtcNow.AddSeconds(budget);
        // One talk with the device at a time on this computer, even from two copies of the app.
        System.Threading.Mutex one;
        try { one = new System.Threading.Mutex(false, "Global\\PezhoheshK50Device"); }
        catch { one = new System.Threading.Mutex(false, "Local\\PezhoheshK50Device"); }
        bool mine;
        try { mine = one.WaitOne(TimeSpan.FromSeconds(Math.Min(60, Math.Max(5, SecondsLeft() / 2)))); }
        catch (System.Threading.AbandonedMutexException) { mine = true; }  // the last helper was stopped; the device is free
        if (!mine) return Obj("ok", false, "error", "busy");
        try { return Talk(req); }
        finally { one.ReleaseMutex(); }
    }

    static Dictionary<string, object> Talk(Dictionary<string, object> req)
    {
        m = Int(req, "machine");
        if (m <= 0) m = 1;
        var key = Int(req, "key");
        if (key != 0) zk.SetCommPassword(key);
        if (!(bool)zk.Connect_Net(Str(req, "ip"), Int(req, "port")))
            return Obj("ok", false, "error", "connect_failed", "code", LastError());

        var ops = new List<Dictionary<string, object>>();
        object list;
        if (req.TryGetValue("ops", out list) && list is IEnumerable)
            foreach (var o in (IEnumerable)list) ops.Add(o as Dictionary<string, object> ?? new Dictionary<string, object>());

        var writes = ops.Any(o => new[] { "set_user", "set_time", "put_fingers", "delete_user", "move_fingers", "clear_logs" }.Contains(Str(o, "op")));
        var results = new ArrayList();
        try
        {
            if (writes) Lock();
            foreach (var o in ops)
            {
                // Out of time: the rest is left for the next talk, and this one ends properly.
                if (Late()) { results.Add(Obj("ok", false, "error", "out_of_time")); continue; }
                try { results.Add(Op(o)); }
                catch (Exception e) { results.Add(Obj("ok", false, "error", "exception", "detail", e.Message)); }
            }
        }
        finally
        {
            if (writes)
            {
                try { zk.RefreshData(m); } catch { }
                try { zk.EnableDevice(m, true); } catch { }
            }
            try { zk.Disconnect(); } catch { }
        }
        return Obj("ok", true, "results", results);
    }

    // Locks the device's keypad and fingers while writing. With a timeout where the SDK has
    // one, so the device unlocks itself if this helper never gets to unlock it.
    static void Lock()
    {
        if (Has("DisableDeviceWithTimeOut"))
        {
            try
            {
                if ((bool)zk.DisableDeviceWithTimeOut(m, Math.Min(900, SecondsLeft() + 30))) return;
            }
            catch { }
        }
        zk.EnableDevice(m, false);
    }

    static Dictionary<string, object> Op(Dictionary<string, object> o)
    {
        switch (Str(o, "op"))
        {
            case "info": return Info();
            case "user": return UserInfo(Str(o, "no"));
            case "set_user": return SetUser(o);
            case "delete_user": return DeleteUser(Str(o, "no"));
            case "enroll":
            {
                var no = Str(o, "no");
                var f = Int(o, "finger");
                // A finger already stored for this ID is never replaced.
                string tmp = "";
                int len = 0;
                try { if ((bool)zk.SSR_GetUserTmpStr(m, no, f, ref tmp, ref len)) return Obj("ok", false, "error", "finger_taken"); } catch { }
                zk.CancelOperation();
                bool ok = zk.StartEnrollEx(no, f, 1);
                if (!ok) ok = zk.StartEnroll(int.Parse(no, CultureInfo.InvariantCulture), f);
                return ok ? Obj("ok", true) : Obj("ok", false, "error", "enroll_failed", "code", LastError());
            }
            case "logs": return Logs(Str(o, "since"), o.ContainsKey("known") ? Int(o, "known") : -1);
            case "users": return Users(Bool(o, "valid"));
            case "fingers": return Fingers();
            case "put_fingers": return PutFingers(o);
            case "move_fingers": return MoveFingers(Str(o, "from"), Str(o, "to"));
            case "set_time": return Obj("ok", (bool)zk.SetDeviceTime(m));
            // Only the punches; users, fingers and settings stay. The app has read them all first.
            case "clear_logs": return (bool)zk.ClearGLog(m) ? Obj("ok", true) : Obj("ok", false, "error", "clear_failed", "code", LastError());
            case "time":
            {
                int y = 0, mo = 0, d = 0, h = 0, mi = 0, se = 0;
                zk.GetDeviceTime(m, ref y, ref mo, ref d, ref h, ref mi, ref se);
                return Obj("ok", true, "time", Stamp(y, mo, d, h, mi, se));
            }
            default: return Obj("ok", false, "error", "unknown_op");
        }
    }

    static Dictionary<string, object> Info()
    {
        string sn = "", fw = "", plat = "";
        int users = 0, fps = 0, logs = 0;
        string mac = "";
        zk.GetSerialNumber(m, ref sn);
        try { zk.GetDeviceMAC(m, ref mac); } catch { }
        zk.GetFirmwareVersion(m, ref fw);
        try { zk.GetPlatform(m, ref plat); } catch { }
        zk.GetDeviceStatus(m, 2, ref users);
        zk.GetDeviceStatus(m, 3, ref fps);
        zk.GetDeviceStatus(m, 6, ref logs);
        int y = 0, mo = 0, d = 0, h = 0, mi = 0, se = 0;
        zk.GetDeviceTime(m, ref y, ref mo, ref d, ref h, ref mi, ref se);
        var calls = new Dictionary<string, object>();
        foreach (var c in new[] { "SetUserValidDate", "GetUserValidDate", "SSR_SetUserInfo", "StartEnrollEx", "SSR_GetGeneralLogData", "DisableDeviceWithTimeOut", "ReadTimeGLogData" })
            calls[c] = Has(c);
        return Obj("ok", true, "serial", sn, "mac", mac, "firmware", fw, "platform", plat, "users", users, "fingers", fps, "logs", logs,
            "time", Stamp(y, mo, d, h, mi, se), "calls", calls, "bits", IntPtr.Size * 8);
    }

    static Dictionary<string, object> UserInfo(string no)
    {
        string name = "", pw = "";
        int priv = 0;
        bool en = false;
        if (!(bool)zk.SSR_GetUserInfo(m, no, ref name, ref pw, ref priv, ref en)) return Obj("ok", true, "exists", false);
        var fingers = 0;
        // Which fingers (0 left little ... 4 left thumb, 5 right thumb ... 9 right little).
        var which = new ArrayList();
        for (var f = 0; f < 10; f++)
        {
            string tmp = "";
            int len = 0;
            try { if ((bool)zk.SSR_GetUserTmpStr(m, no, f, ref tmp, ref len)) { fingers++; which.Add(f); } } catch { }
        }
        object valid = null;
        try
        {
            int exp = 0, cnt = 0;
            string s = "", e = "";
            if ((bool)zk.GetUserValidDate(m, no, ref exp, ref cnt, ref s, ref e)) valid = Obj("expires", exp, "start", s, "end", e);
        }
        catch { }
        object group = null;
        try
        {
            int g = 0;
            if ((bool)zk.GetUserGroup(m, int.Parse(no, CultureInfo.InvariantCulture), ref g)) group = g;
        }
        catch { }
        object zones = null;
        try
        {
            string tz = "";
            if ((bool)zk.SSR_GetUserTZStr(m, no, ref tz)) zones = tz;
        }
        catch
        {
            try
            {
                string tz = "";
                if ((bool)zk.GetUserTZStr(m, int.Parse(no, CultureInfo.InvariantCulture), ref tz)) zones = tz;
            }
            catch { }
        }
        return Obj("ok", true, "exists", true, "name", name, "enabled", en, "privilege", priv, "fingers", fingers, "finger_list", which, "valid", valid,
            "group", group, "zones", zones);
    }

    static Dictionary<string, object> SetUser(Dictionary<string, object> o)
    {
        var no = Str(o, "no");
        // Keep the name, password and privilege the device already has for this user.
        string name = "", pw = "";
        int priv = 0;
        bool en = false;
        bool had = zk.SSR_GetUserInfo(m, no, ref name, ref pw, ref priv, ref en);
        // The device's own administrators are left as they are.
        if (had && priv > 0) return Obj("ok", false, "error", "device_admin");
        // `owner`: the name this ID should carry if it is already on the device. A different
        // name means the number belongs to someone else there, and nothing is written.
        var owner = Str(o, "owner");
        if (had && owner != "" && name.Trim() != owner.Trim())
            return Obj("ok", false, "error", "taken", "device_name", name);
        // Closing an ID the device does not have is nothing to do.
        if (!had && Bool(o, "existing")) return Obj("ok", true, "created", false, "absent", true);
        if (!had) { name = Str(o, "name"); pw = ""; priv = 0; }
        // A partner changed this user's name on «کاربران دستگاه».
        else if (Bool(o, "rename") && Str(o, "name") != "") name = Str(o, "name");
        var enabled = Bool(o, "enabled");
        var start = Str(o, "start");
        var end = Str(o, "end");
        // `keep_open`: while ZKAccess still renews members too, a user the device lets in today
        // or later on days the app never wrote (`pushed_end` is the app's last end) was renewed
        // there. They are not closed and their days are not cut: the app's days are joined to
        // the device's (2026-11-04: a member renewed early in the app was closed although
        // ZKAccess had her current month on the device).
        object kept = null;
        if (had && en && Bool(o, "keep_open"))
        {
            int exp = 0, cnt = 0;
            string ds = "", de = "";
            bool got = false;
            try { got = (bool)zk.GetUserValidDate(m, no, ref exp, ref cnt, ref ds, ref de); } catch { }
            var dStart = Day(ds);
            var dEnd = Day(de);
            var today = DateTime.Now.ToString("yyyyMMdd", CultureInfo.InvariantCulture);
            bool zkDays = got && exp != 0 && dStart.Length == 8 && dEnd.Length == 8 && string.CompareOrdinal(dEnd, today) >= 0 && dEnd != Day(Str(o, "pushed_end"));
            // ZKAccess's last day is typed by hand and is often a day or two off the app's
            // 30 days: within `margin` days of the app's last day it is the same month, and
            // the app's day counts.
            if (zkDays && Day(end).Length == 8)
            {
                var appEnd = DateTime.ParseExact(Day(end), "yyyyMMdd", CultureInfo.InvariantCulture);
                var zkEnd = DateTime.ParseExact(dEnd, "yyyyMMdd", CultureInfo.InvariantCulture);
                if (Math.Abs((zkEnd - appEnd).TotalDays) <= Int(o, "margin")) zkDays = false;
            }
            if (zkDays)
            {
                kept = Obj("start", ds, "end", de);
                enabled = true;
                var iso = new Func<string, string>(d => d.Substring(0, 4) + "-" + d.Substring(4, 2) + "-" + d.Substring(6, 2));
                if (start == "" || end == "") { start = iso(dStart); end = iso(dEnd); }
                else
                {
                    if (string.CompareOrdinal(dStart, Day(start)) < 0) start = iso(dStart);
                    if (string.CompareOrdinal(dEnd, Day(end)) > 0) end = iso(dEnd);
                }
            }
        }
        if (!(bool)zk.SSR_SetUserInfo(m, no, name, pw, priv, enabled))
            return Obj("ok", false, "error", "set_user_failed", "code", LastError());
        object dates = null;
        object read = null;
        if (start != "" && end != "") dates = SetValid(no, start, end, out read);
        return Obj("ok", true, "created", !had, "valid_dates", dates, "date_form", dateForm, "valid_read", read, "kept_open", kept);
    }

    // Takes the user off the device with every finger, card and password (backup number 12),
    // then reads the ID again to be sure it is gone. The device's administrators stay.
    static Dictionary<string, object> DeleteUser(string no)
    {
        string name = "", pw = "";
        int priv = 0;
        bool en = false;
        if (!(bool)zk.SSR_GetUserInfo(m, no, ref name, ref pw, ref priv, ref en)) return Obj("ok", true, "existed", false);
        if (priv > 0) return Obj("ok", false, "error", "device_admin");
        bool done = false;
        try { done = (bool)zk.SSR_DeleteEnrollData(m, no, 12); } catch { }
        if (!done)
        {
            // Older firmware: the fingers first, then the user.
            try { zk.SSR_DeleteEnrollDataExt(m, no, 13); } catch { }
            try { done = (bool)zk.SSR_DeleteEnrollData(m, no, 12); } catch { }
        }
        if (!done) return Obj("ok", false, "error", "delete_failed", "code", LastError());
        string n2 = "", p2 = "";
        int pr2 = 0;
        bool e2 = false;
        if ((bool)zk.SSR_GetUserInfo(m, no, ref n2, ref p2, ref pr2, ref e2)) return Obj("ok", false, "error", "still_there");
        return Obj("ok", true, "existed", true, "name", name);
    }

    // A form counts only when the device gives the same days back (some take a form and
    // store something else). Without a read-back call the first form it takes is kept.
    static bool SetValid(string no, string start, string end, out object read)
    {
        read = null;
        var forms = new List<string[]>
        {
            new[] { start + " 00:00:00", end + " 23:59:59" },
            new[] { start, end },
            new[] { start.Replace("-", ""), end.Replace("-", "") },
        };
        var order = Enumerable.Range(0, forms.Count).ToList();
        if (dateForm.HasValue) order.Insert(0, dateForm.Value);
        foreach (var i in order)
        {
            bool taken;
            try { taken = zk.SetUserValidDate(m, no, 1, 0, forms[i][0], forms[i][1]); }
            catch { return false; }  // this SDK has no such call
            if (!taken) continue;
            // `read` is always what the device gave back for this form, never an earlier one.
            read = null;
            bool? same = null;
            try
            {
                int exp = 0, cnt = 0;
                string s = "", e = "";
                if ((bool)zk.GetUserValidDate(m, no, ref exp, ref cnt, ref s, ref e))
                {
                    read = Obj("expires", exp, "start", s, "end", e);
                    same = exp != 0 && Day(s) == Day(start) && Day(e) == Day(end);
                }
                // The device took the days but cannot give them back: not the days it was given.
                else same = false;
            }
            catch { }  // this SDK has no read-back call: the first form taken is kept
            if (same == false) continue;
            if (!dateForm.HasValue) dateForm = i;
            return true;
        }
        return false;
    }

    // The day of a date written any of these ways, as yyyyMMdd: 2026-10-28, 20261028,
    // 2026/10/28 00:00:00, and as the K50 gives it back, without leading zeros:
    // "2026-11-3 0:0:0" is 20261103 (taking the first eight digits made it 20261130).
    static string Day(string text)
    {
        var parts = System.Text.RegularExpressions.Regex.Matches(text ?? "", "[0-9]+").Cast<System.Text.RegularExpressions.Match>().Select(x => x.Value).ToList();
        if (parts.Count == 0) return "";
        if (parts[0].Length >= 8) return parts[0].Substring(0, 8);
        if (parts.Count >= 3 && parts[0].Length == 4) return parts[0] + parts[1].PadLeft(2, '0') + parts[2].PadLeft(2, '0');
        return string.Concat(parts);
    }

    // Every punch after `since` ("yyyy-MM-dd HH:mm:ss", the device's own clock). The device
    // keeps every punch it ever took (tens of thousands), so reading them all each time is a
    // long, heavy talk. First the count is asked: the same as `known` means nothing new. Then,
    // where the device can, only the punches from `since` on are read; the whole list only
    // when that is not possible.
    static Dictionary<string, object> Logs(string since, int known)
    {
        int count = -1;
        try { if (!(bool)zk.GetDeviceStatus(m, 6, ref count)) count = -1; } catch { count = -1; }
        if (count >= 0 && count == known) return Obj("ok", true, "logs", new ArrayList(), "count", count, "read", "none");
        var list = new ArrayList();
        string how = "all";
        bool partial = false;
        if (since != "" && Has("ReadTimeGLogData"))
        {
            bool read = false;
            try { read = (bool)zk.ReadTimeGLogData(m, since, Stamp(DateTime.Now.Year + 1, 1, 1, 0, 0, 0)); } catch { }
            if (read) partial = ReadLogs(since, list);
            // Some firmware takes the call and gives nothing back: then the whole list.
            if (list.Count > 0 || (count >= 0 && known >= 0 && count <= known)) how = "since";
            else list.Clear();
        }
        if (how == "all" && (bool)zk.ReadGeneralLogData(m)) partial = ReadLogs(since, list);
        return Obj("ok", true, "logs", list, "count", count, "read", how, "partial", partial);
    }

    // The punches the SDK holds after a read, newer than `since`. True when time ran out first.
    static bool ReadLogs(string since, ArrayList list)
    {
        string no = "";
        int vm = 0, io = 0, y = 0, mo = 0, d = 0, h = 0, mi = 0, se = 0, wc = 0;
        while ((bool)zk.SSR_GetGeneralLogData(m, ref no, ref vm, ref io, ref y, ref mo, ref d, ref h, ref mi, ref se, ref wc))
        {
            var at = Stamp(y, mo, d, h, mi, se);
            if (since == "" || string.CompareOrdinal(at, since) > 0) list.Add(Obj("no", no, "at", at, "verify", vm, "io", io));
            if (Late()) return true;
        }
        return false;
    }

    // Every user on the device (ID, name, admin or not), to compare with the app; with
    // `valid`, also the dates each one is let in.
    static Dictionary<string, object> Users(bool valid)
    {
        var list = new List<Dictionary<string, object>>();
        if ((bool)zk.ReadAllUserID(m))
        {
            string no = "", name = "", pw = "";
            int priv = 0;
            bool en = false;
            while ((bool)zk.SSR_GetAllUserInfo(m, ref no, ref name, ref pw, ref priv, ref en))
                list.Add(Obj("no", no, "name", name, "privilege", priv, "enabled", en));
        }
        if (valid)
            foreach (var u in list)
            {
                if (Late()) return Obj("ok", false, "error", "out_of_time");
                try
                {
                    int exp = 0, cnt = 0;
                    string s = "", e = "";
                    if ((bool)zk.GetUserValidDate(m, (string)u["no"], ref exp, ref cnt, ref s, ref e))
                        u["valid"] = Obj("expires", exp, "start", s, "end", e);
                }
                catch { }
            }
        return Obj("ok", true, "users", list);
    }

    // Every stored finger on the device, for the app's own backup copy.
    static Dictionary<string, object> Fingers()
    {
        var nos = new List<string>();
        if ((bool)zk.ReadAllUserID(m))
        {
            string no = "", name = "", pw = "";
            int priv = 0;
            bool en = false;
            while ((bool)zk.SSR_GetAllUserInfo(m, ref no, ref name, ref pw, ref priv, ref en)) nos.Add(no);
        }
        // Reads all templates into the SDK's memory at once; the calls below then stay local.
        try { zk.ReadAllTemplate(m); } catch { }
        var ex = Has("GetUserTmpExStr");
        var list = new ArrayList();
        foreach (var no in nos)
            for (var f = 0; f < 10; f++)
            {
                if (Late()) return Obj("ok", false, "error", "out_of_time");
                string tmp = "";
                int len = 0, flag = 1;
                bool got;
                try { got = ex ? (bool)zk.GetUserTmpExStr(m, no, f, ref flag, ref tmp, ref len) : (bool)zk.SSR_GetUserTmpStr(m, no, f, ref tmp, ref len); }
                catch { got = false; }
                if (got && !string.IsNullOrEmpty(tmp)) list.Add(Obj("no", no, "finger", f, "flag", flag, "template", tmp));
            }
        return Obj("ok", true, "users", nos.Count, "fingers", list);
    }

    // Puts saved fingers back on a user the device lost. A finger the device already has is kept.
    static Dictionary<string, object> PutFingers(Dictionary<string, object> o)
    {
        var no = Str(o, "no");
        string name = "", pw = "";
        int priv = 0;
        bool en = false;
        if (!(bool)zk.SSR_GetUserInfo(m, no, ref name, ref pw, ref priv, ref en)) return Obj("ok", false, "error", "no_user");
        var ex = Has("SetUserTmpExStr");
        int put = 0, kept = 0, failed = 0;
        object list;
        if (o.TryGetValue("fingers", out list) && list is IEnumerable)
            foreach (var item in (IEnumerable)list)
            {
                var t = item as Dictionary<string, object>;
                if (t == null) continue;
                var f = Int(t, "finger");
                string have = "";
                int len = 0;
                try { if ((bool)zk.SSR_GetUserTmpStr(m, no, f, ref have, ref len)) { kept++; continue; } } catch { }
                bool ok;
                try { ok = ex ? (bool)zk.SetUserTmpExStr(m, no, f, Int(t, "flag"), Str(t, "template")) : (bool)zk.SSR_SetUserTmpStr(m, no, f, Str(t, "template")); }
                catch { ok = false; }
                if (ok) put++; else failed++;
            }
        return Obj("ok", failed == 0, "put", put, "kept", kept, "failed", failed, "error", failed == 0 ? null : "put_fingers_failed");
    }

    // A member's ID was changed: copies every finger of `from` onto `to` (a finger `to`
    // already has is kept). The caller removes `from` only when this says ok.
    static Dictionary<string, object> MoveFingers(string from, string to)
    {
        string name = "", pw = "";
        int priv = 0;
        bool en = false;
        if (!(bool)zk.SSR_GetUserInfo(m, to, ref name, ref pw, ref priv, ref en)) return Obj("ok", false, "error", "no_user");
        if (!(bool)zk.SSR_GetUserInfo(m, from, ref name, ref pw, ref priv, ref en)) return Obj("ok", true, "moved", 0, "absent", true);
        var getEx = Has("GetUserTmpExStr");
        var setEx = Has("SetUserTmpExStr");
        int moved = 0, kept = 0, failed = 0;
        for (var f = 0; f < 10; f++)
        {
            string tmp = "";
            int len = 0, flag = 1;
            bool got;
            try { got = getEx ? (bool)zk.GetUserTmpExStr(m, from, f, ref flag, ref tmp, ref len) : (bool)zk.SSR_GetUserTmpStr(m, from, f, ref tmp, ref len); }
            catch { got = false; }
            if (!got || string.IsNullOrEmpty(tmp)) continue;
            string have = "";
            int hlen = 0;
            try { if ((bool)zk.SSR_GetUserTmpStr(m, to, f, ref have, ref hlen)) { kept++; continue; } } catch { }
            bool ok;
            try { ok = setEx ? (bool)zk.SetUserTmpExStr(m, to, f, flag, tmp) : (bool)zk.SSR_SetUserTmpStr(m, to, f, tmp); }
            catch { ok = false; }
            if (ok) moved++; else failed++;
        }
        try { zk.RefreshData(m); } catch { }
        return Obj("ok", failed == 0, "moved", moved, "kept", kept, "failed", failed, "error", failed == 0 ? null : "move_fingers_failed");
    }

    static int LastError()
    {
        var e = 0;
        try { zk.GetLastError(ref e); } catch { }
        return e;
    }

    // Whether this SDK version has a call by that name.
    static bool Has(string name)
    {
        var dispatch = (object)zk as IDispatch;
        if (dispatch == null) return false;
        var iid = Guid.Empty;
        var ids = new int[1];
        return dispatch.GetIDsOfNames(ref iid, new[] { name }, 1, 0, ids) == 0;
    }

    [ComImport, Guid("00020400-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDispatch
    {
        [PreserveSig] int GetTypeInfoCount(out int count);
        [PreserveSig] int GetTypeInfo(int index, int lcid, out IntPtr info);
        [PreserveSig] int GetIDsOfNames(ref Guid iid, [MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.LPWStr)] string[] names,
            int count, int lcid, [Out, MarshalAs(UnmanagedType.LPArray)] int[] ids);
    }

    static string Stamp(int y, int mo, int d, int h, int mi, int se)
    {
        return string.Format(CultureInfo.InvariantCulture, "{0:D4}-{1:D2}-{2:D2} {3:D2}:{4:D2}:{5:D2}", y, mo, d, h, mi, se);
    }

    // ---------------------------------------------------------------------------
    // The SDK
    //
    // The app keeps its own copy of ZKTeco's SDK in %APPDATA%\Pezhohesh\zk, copied once from
    // the files ZKAccess installed (or from a folder of ZKTeco's SDK download). A manifest
    // written next to it lets this program use it without registering anything in Windows, so
    // removing ZKAccess, or registering another SDK version, changes nothing here.

    const string ZkClass = "{00853A19-BD51-419B-9269-2DABE57EB61F}";

    // The SDK's own files (Standalone SDK 6.3.1.x); zkemkeeper.dll loads them by name.
    static readonly string[] SdkFiles = {
        "zkemkeeper.dll", "zkemsdk.dll", "commpro.dll", "comms.dll", "rscagent.dll", "rscomm.dll",
        "tcpcomm.dll", "usbcomm.dll", "usbstd.dll", "plcommpro.dll", "plcomms.dll", "plrscagent.dll",
        "plrscomm.dll", "pltcpcomm.dll", "plusbcomm.dll" };

    static string AppSdkDir()
    {
        return Path.Combine(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Pezhohesh"), "zk");
    }

    static void LoadSdk()
    {
        var dir = AppSdkDir();
        var manifest = Path.Combine(dir, "zk.manifest");
        if (File.Exists(manifest) && File.Exists(Path.Combine(dir, "zkemkeeper.dll")))
        {
            SetDllDirectory(dir);
            var ctx = new ActCtx
            {
                cbSize = Marshal.SizeOf(typeof(ActCtx)),
                dwFlags = 0x4, // ACTCTX_FLAG_ASSEMBLY_DIRECTORY_VALID
                lpSource = manifest,
                lpAssemblyDirectory = dir,
            };
            var handle = CreateActCtxW(ref ctx);
            IntPtr cookie;
            // Stays active for the life of this short program.
            if (handle != new IntPtr(-1)) ActivateActCtx(handle, out cookie);
            try { zk = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid(ZkClass), true)); }
            catch { }
        }
        foreach (var id in new[] { "zkemkeeper.ZKEM.1", "zkemkeeper.ZKEM", "zkemkeeper.CZKEM" })
        {
            if (zk != null) break;
            try
            {
                var type = Type.GetTypeFromProgID(id);
                if (type != null) zk = Activator.CreateInstance(type);
            }
            catch { }
        }
    }

    static Dictionary<string, object> SdkStatus()
    {
        var dir = AppSdkDir();
        var copy = Path.Combine(dir, "zkemkeeper.dll");
        return Obj("ok", true, "loaded", zk != null,
            "app_copy", File.Exists(copy) && File.Exists(Path.Combine(dir, "zk.manifest")),
            "app_version", File.Exists(copy) ? FileVersion(copy) : null,
            "system", RegisteredSdk());
    }

    // "app" when the loaded zkemkeeper.dll is the app's own copy, otherwise its path.
    static string SdkFile()
    {
        try
        {
            foreach (System.Diagnostics.ProcessModule mod in System.Diagnostics.Process.GetCurrentProcess().Modules)
                if (string.Equals(mod.ModuleName, "zkemkeeper.dll", StringComparison.OrdinalIgnoreCase))
                    return SameDir(Path.GetDirectoryName(mod.FileName), AppSdkDir()) ? "app" : mod.FileName;
        }
        catch { }
        return "unknown";
    }

    // The zkemkeeper.dll Windows has registered (ZKAccess's), if any.
    static string RegisteredSdk()
    {
        try
        {
            using (var key = Microsoft.Win32.Registry.ClassesRoot.OpenSubKey("CLSID\\" + ZkClass + "\\InprocServer32"))
            {
                var path = key == null ? null : key.GetValue("") as string;
                if (string.IsNullOrEmpty(path)) return null;
                path = Environment.ExpandEnvironmentVariables(path.Trim().Trim('"'));
                return File.Exists(path) ? path : null;
            }
        }
        catch { return null; }
    }

    static Dictionary<string, object> InstallSdk(string from)
    {
        // Where the files come from: the folder given, or the copy ZKAccess registered.
        from = (from ?? "").Trim().Trim('"');
        string source;
        if (from.Length == 0)
        {
            var registered = RegisteredSdk();
            if (registered == null) return Obj("ok", false, "error", "sdk_not_found");
            source = Path.GetDirectoryName(registered);
        }
        else if (File.Exists(from)) source = Path.GetDirectoryName(from);
        else if (File.Exists(Path.Combine(Path.Combine(from, "32bit"), "zkemkeeper.dll"))) source = Path.Combine(from, "32bit");
        else source = from;
        var main = Path.Combine(source, "zkemkeeper.dll");
        if (!File.Exists(main)) return Obj("ok", false, "error", "sdk_not_found", "from", source);
        if (Machine(main) != 0x14c) return Obj("ok", false, "error", "sdk_not_32bit", "from", source);
        var dir = AppSdkDir();
        if (SameDir(source, dir)) return Obj("ok", false, "error", "sdk_same_folder");

        // The class and type library ids and version, read from the file itself.
        ComTypes.ITypeLib lib;
        LoadTypeLibEx(main, 2 /* REGKIND_NONE */, out lib);
        IntPtr p;
        lib.GetLibAttr(out p);
        var attr = (ComTypes.TYPELIBATTR)Marshal.PtrToStructure(p, typeof(ComTypes.TYPELIBATTR));
        lib.ReleaseTLibAttr(p);
        var hasClass = false;
        for (var i = 0; i < lib.GetTypeInfoCount() && !hasClass; i++)
        {
            ComTypes.TYPEKIND kind;
            lib.GetTypeInfoType(i, out kind);
            if (kind != ComTypes.TYPEKIND.TKIND_COCLASS) continue;
            ComTypes.ITypeInfo info;
            lib.GetTypeInfo(i, out info);
            IntPtr t;
            info.GetTypeAttr(out t);
            var ta = (ComTypes.TYPEATTR)Marshal.PtrToStructure(t, typeof(ComTypes.TYPEATTR));
            info.ReleaseTypeAttr(t);
            hasClass = ta.guid == new Guid(ZkClass);
        }
        if (!hasClass) return Obj("ok", false, "error", "sdk_unknown_class", "from", source);

        // The SDK's files, plus any other ZKTeco library they need from the same folder.
        var names = new List<string>();
        foreach (var n in SdkFiles)
            if (File.Exists(Path.Combine(source, n))) names.Add(n);
        for (var i = 0; i < names.Count; i++)
            foreach (var n in Imports(Path.Combine(source, names[i])))
                if (!names.Contains(n, StringComparer.OrdinalIgnoreCase) && File.Exists(Path.Combine(source, n)) && FromZk(Path.Combine(source, n)))
                    names.Add(n);

        // Written to a new folder first, so a failed copy leaves the old one working.
        var fresh = dir + ".new";
        if (Directory.Exists(fresh)) Directory.Delete(fresh, true);
        Directory.CreateDirectory(fresh);
        foreach (var n in names) File.Copy(Path.Combine(source, n), Path.Combine(fresh, n), true);
        var files = new StringBuilder();
        foreach (var n in names)
            if (!string.Equals(n, "zkemkeeper.dll", StringComparison.OrdinalIgnoreCase))
                files.AppendFormat("  <file name=\"{0}\"/>\r\n", System.Security.SecurityElement.Escape(n));
        var lib_id = attr.guid.ToString("B").ToUpperInvariant();
        File.WriteAllText(Path.Combine(fresh, "zk.manifest"), string.Format(CultureInfo.InvariantCulture,
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n" +
            "<assembly xmlns=\"urn:schemas-microsoft-com:asm.v1\" manifestVersion=\"1.0\">\r\n" +
            "  <assemblyIdentity name=\"Pezhohesh.ZKTecoSDK\" version=\"1.0.0.0\" type=\"win32\" processorArchitecture=\"x86\"/>\r\n" +
            "  <file name=\"zkemkeeper.dll\">\r\n" +
            "    <comClass clsid=\"{0}\" threadingModel=\"Apartment\" tlbid=\"{1}\"/>\r\n" +
            "    <typelib tlbid=\"{1}\" version=\"{2}.{3}\" helpdir=\"\"/>\r\n" +
            "  </file>\r\n{4}</assembly>\r\n", ZkClass, lib_id, attr.wMajorVerNum, attr.wMinorVerNum, files), new UTF8Encoding(false));
        var old = dir + ".old";
        if (Directory.Exists(old)) Directory.Delete(old, true);
        if (Directory.Exists(dir)) Directory.Move(dir, old);
        Directory.Move(fresh, dir);
        if (Directory.Exists(old)) try { Directory.Delete(old, true); } catch { }
        return Obj("ok", true, "from", source, "files", names, "version", FileVersion(Path.Combine(dir, "zkemkeeper.dll")));
    }

    static bool SameDir(string a, string b)
    {
        try { return string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }

    static string FileVersion(string path)
    {
        try
        {
            var v = System.Diagnostics.FileVersionInfo.GetVersionInfo(path);
            return string.Format(CultureInfo.InvariantCulture, "{0}.{1}.{2}.{3}", v.FileMajorPart, v.FileMinorPart, v.FileBuildPart, v.FilePrivatePart);
        }
        catch { return null; }
    }

    static bool FromZk(string path)
    {
        try
        {
            var v = System.Diagnostics.FileVersionInfo.GetVersionInfo(path);
            return ((v.CompanyName ?? "") + " " + (v.ProductName ?? "")).IndexOf("ZK", StringComparison.OrdinalIgnoreCase) >= 0;
        }
        catch { return false; }
    }

    // The PE file's machine (0x14c is 32-bit x86).
    static int Machine(string path)
    {
        var d = File.ReadAllBytes(path);
        if (d.Length < 0x40 || d[0] != 'M' || d[1] != 'Z') return 0;
        var pe = BitConverter.ToInt32(d, 0x3c);
        if (pe < 0 || pe + 6 > d.Length || BitConverter.ToUInt32(d, pe) != 0x4550) return 0;
        return BitConverter.ToUInt16(d, pe + 4);
    }

    // The DLL names in a 32-bit PE file's import table.
    static List<string> Imports(string path)
    {
        var names = new List<string>();
        try
        {
            var d = File.ReadAllBytes(path);
            var pe = BitConverter.ToInt32(d, 0x3c);
            int sections = BitConverter.ToUInt16(d, pe + 6), optSize = BitConverter.ToUInt16(d, pe + 20);
            var opt = pe + 24;
            if (BitConverter.ToUInt16(d, opt) != 0x10b) return names;
            var importRva = BitConverter.ToInt32(d, opt + 96 + 8);
            Func<int, int> at = rva =>
            {
                for (var i = 0; i < sections; i++)
                {
                    var sh = opt + optSize + i * 40;
                    int va = BitConverter.ToInt32(d, sh + 12), size = BitConverter.ToInt32(d, sh + 16), raw = BitConverter.ToInt32(d, sh + 20);
                    if (rva >= va && rva < va + size) return raw + rva - va;
                }
                return -1;
            };
            for (var desc = at(importRva); desc > 0 && desc + 20 <= d.Length; desc += 20)
            {
                var nameRva = BitConverter.ToInt32(d, desc + 12);
                if (nameRva == 0) break;
                var o = at(nameRva);
                if (o < 0) break;
                var end = Array.IndexOf(d, (byte)0, o);
                if (end > o) names.Add(Encoding.ASCII.GetString(d, o, end - o));
            }
        }
        catch { }
        return names;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ActCtx
    {
        public int cbSize;
        public uint dwFlags;
        public string lpSource;
        public ushort wProcessorArchitecture;
        public ushort wLangId;
        public string lpAssemblyDirectory;
        public string lpResourceName;
        public string lpApplicationName;
        public IntPtr hModule;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateActCtxW(ref ActCtx ctx);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ActivateActCtx(IntPtr ctx, out IntPtr cookie);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool SetDllDirectory(string dir);

    [DllImport("oleaut32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void LoadTypeLibEx(string file, int regKind, out ComTypes.ITypeLib lib);

    // ---------------------------------------------------------------------------
    // JSON

    static JavaScriptSerializer Json()
    {
        return new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 16 };
    }

    // The answer goes out as raw UTF-8 bytes, whatever code page the console has (names are Persian).
    static int Answer(Dictionary<string, object> o)
    {
        if (zk != null) o["sdk"] = SdkFile();
        var bytes = new UTF8Encoding(false).GetBytes(Json().Serialize(o));
        using (var output = Console.OpenStandardOutput())
        {
            output.Write(bytes, 0, bytes.Length);
            output.Flush();
        }
        return 0;
    }

    static Dictionary<string, object> Obj(params object[] pairs)
    {
        var o = new Dictionary<string, object>();
        for (var i = 0; i + 1 < pairs.Length; i += 2) o[(string)pairs[i]] = pairs[i + 1];
        return o;
    }

    static string Str(IDictionary<string, object> o, string key)
    {
        object v;
        return o.TryGetValue(key, out v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) : "";
    }

    static int Int(IDictionary<string, object> o, string key)
    {
        object v;
        if (!o.TryGetValue(key, out v) || v == null) return 0;
        try { return Convert.ToInt32(v, CultureInfo.InvariantCulture); } catch { return 0; }
    }

    static bool Bool(IDictionary<string, object> o, string key)
    {
        object v;
        return o.TryGetValue(key, out v) && v is bool && (bool)v;
    }
}
