using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using HIDMaestro;

namespace HmBridge;

class Program
{
    static HMContext? _ctx;
    static readonly Dictionary<string, HMController> _controllers = new();

    static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    static void Main()
    {
        using var stdin = new StreamReader(Console.OpenStandardInput());
        string? line;
        while ((line = stdin.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            try
            {
                ProcessMessage(line);
            }
            catch (Exception ex)
            {
                Emit(new { type = "error", message = ex.Message, code = "HM_BRIDGE_ERROR" });
            }
        }
        foreach (var c in _controllers.Values) try { c.Dispose(); } catch { }
        try { _ctx?.Dispose(); } catch { }
    }

    static void ProcessMessage(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var type = root.GetProperty("type").GetString();

        switch (type)
        {
            case "init":    HandleInit(root); break;
            case "create":  HandleCreate(root); break;
            case "state":   HandleState(root); break;
            case "free":    HandleFree(root); break;
            case "destroy_all": HandleDestroyAll(); break;
        }
    }

    static void HandleInit(JsonElement msg)
    {
        if (_ctx != null) return;
        _ctx = new HMContext();
        _ctx.LoadDefaultProfiles();
        Emit(new { type = "ready", message = $"HmBridge ok ({_ctx.AllProfiles.Count} profiles loaded)" });
    }

    static void HandleCreate(JsonElement msg)
    {
        EnsureContext();
        var padId = msg.GetProperty("pad_id").GetString()!;
        if (_controllers.ContainsKey(padId)) return;

        var profileId = "xbox-360-wired";
        if (msg.TryGetProperty("profile", out var pEl))
            profileId = pEl.GetString() ?? profileId;

        var profile = _ctx!.GetProfile(profileId);
        if (profile == null)
        {
            Emit(new { type = "error", message = $"Profile '{profileId}' not found", code = "PROFILE_NOT_FOUND" });
            return;
        }

        if (!_ctx.IsDriverInstalled)
            try { _ctx.InstallDriver(); }
            catch (UnauthorizedAccessException)
            {
                Emit(new { type = "error", message = "HIDMaestro driver needs admin. Run Nearcade as Administrator.", code = "ADMIN_REQUIRED" });
                return;
            }

        HMController controller;
        try { controller = _ctx.CreateController(profile); }
        catch (UnauthorizedAccessException)
        {
            Emit(new { type = "error", message = "Creating controllers needs admin. Run Nearcade as Administrator.", code = "ADMIN_REQUIRED" });
            return;
        }

        var captured = padId;
        controller.OutputReceived += (_, packet) =>
        {
            if (packet.Source == HMOutputSource.XInput)
            {
                var data = packet.Data.Span;
                if (data.Length >= 4)
                {
                    Emit(new
                    {
                        type = "rumble",
                        pad_id = captured,
                        viewer_id = captured,
                        strong = data[2] / 255.0,
                        weak = data[3] / 255.0,
                        duration = 250
                    });
                }
            }
            else if (packet.Source == HMOutputSource.HidOutput && profile.VendorId == 0x045E)
            {
                // Xbox One S / GIP Bluetooth output report 0x03
                var data = packet.Data.Span;
                if (packet.ReportId == 0x03 && data.Length >= 5)
                {
                    byte mask = data[0];
                    double strong = (mask & 0x02) != 0 ? Math.Clamp(data[3] / 100.0, 0.0, 1.0) : 0.0;
                    double weak = (mask & 0x01) != 0 ? Math.Clamp(data[4] / 100.0, 0.0, 1.0) : 0.0;
                    Emit(new
                    {
                        type = "rumble",
                        pad_id = captured,
                        viewer_id = captured,
                        strong,
                        weak,
                        duration = 250
                    });
                }
            }
        };

        controller.OutputDecoded += (_, e) =>
        {
            if (!e.Fields.TryGetValue("leftMotor", out var leftObj) ||
                !e.Fields.TryGetValue("rightMotor", out var rightObj))
                return;

            // Sony DualSense and DualShock 4 reports multiplex lightbar, trigger,
            // and audio writes. Verify rumble update flags to prevent false rumble.
            if (profile.VendorId == 0x054C)
            {
                bool hasRumbleFlag = false;

                // DualShock 4: validFlag0 bit 0 (0x01: motor enable)
                // DualSense: validFlag0 bit 0 (0x01: compatible vibration)
                if (e.Fields.TryGetValue("validFlag0", out var vf0))
                {
                    byte flag0 = Convert.ToByte(vf0);
                    if ((flag0 & 0x01) != 0)
                        hasRumbleFlag = true;
                }

                // DualSense: validFlag2 bit 0 (0x01: compatible vibration v2)
                if (e.Fields.TryGetValue("validFlag2", out var vf2))
                {
                    byte flag2 = Convert.ToByte(vf2);
                    if ((flag2 & 0x01) != 0)
                        hasRumbleFlag = true;
                }

                if (!hasRumbleFlag)
                    return;
            }

            byte leftMotor = Convert.ToByte(leftObj);
            byte rightMotor = Convert.ToByte(rightObj);

            Emit(new
            {
                type = "rumble",
                pad_id = captured,
                viewer_id = captured,
                strong = leftMotor / 255.0,
                weak = rightMotor / 255.0,
                duration = 250
            });
        };

        _controllers[padId] = controller;
        Emit(new { type = "log", message = $"Created {profile.Name} for {padId}" });
    }

    static void HandleState(JsonElement msg)
    {
        if (_ctx == null) return;
        var padId = msg.GetProperty("pad_id").GetString()!;
        if (!_controllers.TryGetValue(padId, out var ctrl)) return;

        double G(string key, double def) =>
            msg.TryGetProperty(key, out var el) ? el.GetDouble() : def;

        var axes = HMGamepadStateHelpers.StandardAxes(ctrl.Profile,
            (float)G("lx", 0.5), (float)G("ly", 0.5),
            (float)G("rx", 0.5), (float)G("ry", 0.5),
            (float)G("lt", 0.0), (float)G("rt", 0.0));

        uint buttons = 0;
        if (msg.TryGetProperty("buttons", out var bEl)) buttons = bEl.GetUInt32();

        int hat = 0;
        if (msg.TryGetProperty("hat", out var hEl)) hat = hEl.GetInt32();

        ctrl.SubmitState(new HMGamepadState { Axes = axes, Buttons = (HMButton)buttons, Hat = (HMHat)hat });
    }

    static void HandleFree(JsonElement msg)
    {
        var padId = msg.GetProperty("pad_id").GetString()!;
        if (_controllers.TryGetValue(padId, out var ctrl))
        {
            ctrl.Dispose();
            _controllers.Remove(padId);
        }
    }

    static void HandleDestroyAll()
    {
        foreach (var c in _controllers.Values) c.Dispose();
        _controllers.Clear();
    }

    static void EnsureContext()
    {
        if (_ctx == null)
        {
            _ctx = new HMContext();
            _ctx.LoadDefaultProfiles();
        }
    }

    static void Emit(object obj)
    {
        Console.WriteLine(JsonSerializer.Serialize(obj, JsonOptions));
        Console.Out.Flush();
    }
}
