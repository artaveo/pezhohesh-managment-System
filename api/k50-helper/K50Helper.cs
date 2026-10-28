// Talks to the ZKTeco K50 through ZKTeco's own Standalone SDK (zkemkeeper.dll, the same one
// ZKAccess uses). It is a small 32-bit program of its own, installed next to the core API,
// because the SDK is a 32-bit COM library. It reads one JSON request on stdin and writes one
// JSON answer on stdout:
//   { "ip": "...", "port": 4370, "machine": 1, "key": 0, "ops": [ { "op": "info" }, ... ] }
//   { "ok": true, "results": [ { "ok": true, ... }, ... ] }   or   { "ok": false, "error": "..." }
// Nothing here deletes a user or a finger; a member who should not come in is disabled.
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
using System.Text;
using System.Web.Script.Serialization;

static class K50Helper
{
    static dynamic zk;
    static int m;
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

        foreach (var id in new[] { "zkemkeeper.ZKEM.1", "zkemkeeper.ZKEM", "zkemkeeper.CZKEM" })
        {
            try
            {
                var type = Type.GetTypeFromProgID(id);
                if (type != null) { zk = Activator.CreateInstance(type); break; }
            }
            catch { }
        }
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

        var writes = ops.Any(o => Str(o, "op") == "set_user" || Str(o, "op") == "set_time");
        var results = new ArrayList();
        try
        {
            if (writes) zk.EnableDevice(m, false);
            foreach (var o in ops)
            {
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

    static Dictionary<string, object> Op(Dictionary<string, object> o)
    {
        switch (Str(o, "op"))
        {
            case "info": return Info();
            case "user": return UserInfo(Str(o, "no"));
            case "set_user": return SetUser(o);
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
            case "logs": return Logs(Str(o, "since"));
            case "users": return Users();
            case "set_time": return Obj("ok", (bool)zk.SetDeviceTime(m));
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
        zk.GetSerialNumber(m, ref sn);
        zk.GetFirmwareVersion(m, ref fw);
        try { zk.GetPlatform(m, ref plat); } catch { }
        zk.GetDeviceStatus(m, 2, ref users);
        zk.GetDeviceStatus(m, 3, ref fps);
        zk.GetDeviceStatus(m, 6, ref logs);
        int y = 0, mo = 0, d = 0, h = 0, mi = 0, se = 0;
        zk.GetDeviceTime(m, ref y, ref mo, ref d, ref h, ref mi, ref se);
        var calls = new Dictionary<string, object>();
        foreach (var c in new[] { "SetUserValidDate", "GetUserValidDate", "SSR_SetUserInfo", "StartEnrollEx", "SSR_GetGeneralLogData" })
            calls[c] = Has(c);
        return Obj("ok", true, "serial", sn, "firmware", fw, "platform", plat, "users", users, "fingers", fps, "logs", logs,
            "time", Stamp(y, mo, d, h, mi, se), "calls", calls, "bits", IntPtr.Size * 8);
    }

    static Dictionary<string, object> UserInfo(string no)
    {
        string name = "", pw = "";
        int priv = 0;
        bool en = false;
        if (!(bool)zk.SSR_GetUserInfo(m, no, ref name, ref pw, ref priv, ref en)) return Obj("ok", true, "exists", false);
        var fingers = 0;
        for (var f = 0; f < 10; f++)
        {
            string tmp = "";
            int len = 0;
            try { if ((bool)zk.SSR_GetUserTmpStr(m, no, f, ref tmp, ref len)) fingers++; } catch { }
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
        return Obj("ok", true, "exists", true, "name", name, "enabled", en, "privilege", priv, "fingers", fingers, "valid", valid,
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
        if (!(bool)zk.SSR_SetUserInfo(m, no, name, pw, priv, Bool(o, "enabled")))
            return Obj("ok", false, "error", "set_user_failed", "code", LastError());
        object dates = null;
        object read = null;
        var start = Str(o, "start");
        var end = Str(o, "end");
        if (start != "" && end != "") dates = SetValid(no, start, end, out read);
        return Obj("ok", true, "created", !had, "valid_dates", dates, "date_form", dateForm, "valid_read", read);
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
            }
            catch { }
            if (same == false) continue;
            if (!dateForm.HasValue) dateForm = i;
            return true;
        }
        return false;
    }

    // The first eight digits of a date written any of these ways: 2026-10-28, 20261028, 2026/10/28 00:00:00.
    static string Day(string text)
    {
        var digits = new string((text ?? "").Where(char.IsDigit).ToArray());
        return digits.Length >= 8 ? digits.Substring(0, 8) : digits;
    }

    // Every punch after `since` ("yyyy-MM-dd HH:mm:ss", the device's own clock).
    static Dictionary<string, object> Logs(string since)
    {
        var list = new ArrayList();
        if ((bool)zk.ReadGeneralLogData(m))
        {
            string no = "";
            int vm = 0, io = 0, y = 0, mo = 0, d = 0, h = 0, mi = 0, se = 0, wc = 0;
            while ((bool)zk.SSR_GetGeneralLogData(m, ref no, ref vm, ref io, ref y, ref mo, ref d, ref h, ref mi, ref se, ref wc))
            {
                var at = Stamp(y, mo, d, h, mi, se);
                if (since == "" || string.CompareOrdinal(at, since) > 0) list.Add(Obj("no", no, "at", at, "verify", vm, "io", io));
            }
        }
        return Obj("ok", true, "logs", list);
    }

    // Every user on the device (ID, name, admin or not), to compare with the app.
    static Dictionary<string, object> Users()
    {
        var list = new ArrayList();
        if ((bool)zk.ReadAllUserID(m))
        {
            string no = "", name = "", pw = "";
            int priv = 0;
            bool en = false;
            while ((bool)zk.SSR_GetAllUserInfo(m, ref no, ref name, ref pw, ref priv, ref en))
                list.Add(Obj("no", no, "name", name, "privilege", priv, "enabled", en));
        }
        return Obj("ok", true, "users", list);
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
    // JSON

    static JavaScriptSerializer Json()
    {
        return new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 16 };
    }

    // The answer goes out as raw UTF-8 bytes, whatever code page the console has (names are Persian).
    static int Answer(Dictionary<string, object> o)
    {
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
