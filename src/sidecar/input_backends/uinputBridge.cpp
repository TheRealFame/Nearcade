#include <napi.h>
#include <linux/uinput.h>
#include <linux/input.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <iostream>
#include <map>
#include <thread>
#include <mutex>
#include <functional>
#include <dirent.h>
#include <fstream>
#include <string>

// ── Packet type constants ──────────────────────────────────────────────────────
namespace PKT {
    enum {
        GAMEPAD   = 0x01, MOUSE_REL = 0x02, MOUSE_ABS = 0x03, MOUSE_BTN = 0x04,
        WHEEL     = 0x05, KEY       = 0x06, ALLOC_GP  = 0x10, FREE_GP   = 0x11,
        FLUSH     = 0x20, DESTROY   = 0xFF
    };
}

// ── W3C button bitmask (matches JS viewer and InputOrchestrator) ───────────────
enum W3C_BTN {
    A = 1<<0, B = 1<<1, Y = 1<<2, X = 1<<3, LB = 1<<4, RB = 1<<5,
    BACK = 1<<8, START = 1<<9, LS = 1<<10, RS = 1<<11, GUIDE = 1<<16
};

// ── Axis fuzz/flat matching linux_uinput.py AXES tuples ───────────────────────
// Sticks:   (-32767, 32767, fuzz=16, flat=128)
// Triggers: (0, 255, fuzz=0, flat=0)
// Hat:      (-1, 1, fuzz=0, flat=0)
static void set_abs(struct uinput_user_dev& uud, int axis,
                    int32_t mn, int32_t mx, int32_t fuzz, int32_t flat) {
    uud.absmin [axis] = mn;
    uud.absmax [axis] = mx;
    uud.absfuzz[axis] = fuzz;
    uud.absflat[axis] = flat;
}

// ── Global file descriptors ────────────────────────────────────────────────────
int kbm_fd = -1;
std::map<uint8_t, int>         gp_fds;    // slot → uinput write fd
std::map<uint8_t, std::string> gp_names;  // slot → device name (for sysfs lookup)

// ── Rumble tracking ────────────────────────────────────────────────────────────
// slot → eventX read fd;  g_padViewers: slot-string → viewerId string
static std::map<uint8_t, int>         g_rumbleFds;
static std::map<std::string, std::string> g_padViewers;
static std::mutex                      g_rumbleMtx;

// JS-side callback invoked from the rumble watcher thread (via threadsafe function)
using RumbleTSFN = Napi::ThreadSafeFunction;
static RumbleTSFN g_rumbleTsfn;
static bool       g_tsfnValid = false;

// ── Helper: write one kernel input_event ──────────────────────────────────────
void emit(int fd, uint16_t type, uint16_t code, int32_t val) {
    if (fd < 0) return;
    struct input_event ie = {};
    ie.type  = type;
    ie.code  = code;
    ie.value = val;
    if (write(fd, &ie, sizeof(ie)) < 0) { /* EAGAIN or device closed – drop */ }
}
void syn(int fd) { emit(fd, EV_SYN, SYN_REPORT, 0); }

// ── Rumble: find /dev/input/eventX by device name via sysfs ──────────────────
static std::string find_event_node(const std::string& dev_name) {
    const char* sys_input = "/sys/class/input";
    DIR* d = opendir(sys_input);
    if (!d) return "";
    struct dirent* ent;
    while ((ent = readdir(d)) != nullptr) {
        std::string entry(ent->d_name);
        if (entry.rfind("event", 0) != 0) continue;
        std::string name_path = std::string(sys_input) + "/" + entry + "/device/name";
        std::ifstream f(name_path);
        if (!f.is_open()) continue;
        std::string name;
        std::getline(f, name);
        if (name == dev_name) {
            closedir(d);
            return std::string("/dev/input/") + entry;
        }
    }
    closedir(d);
    return "";
}

// ── Rumble watcher thread ─────────────────────────────────────────────────────
// Reads EV_FF events from the eventX node and fires g_rumbleTsfn back to JS.
// Format emitted to JS callback: { pad_id, viewerId, strong, weak, duration }
static void rumble_watcher_thread(uint8_t slot, int fd, std::string viewerId) {
    // Size of one linux input_event: timeval(8 or 16 bytes) + type(2) + code(2) + value(4)
    // Use the kernel's own sizeof to be safe with 32/64-bit time_t variants
    const size_t EV_SIZE = sizeof(struct input_event);
    uint8_t buf[sizeof(struct input_event)];

    while (true) {
        // Check if this watcher is still current
        {
            std::lock_guard<std::mutex> lk(g_rumbleMtx);
            auto it = g_rumbleFds.find(slot);
            if (it == g_rumbleFds.end() || it->second != fd) break;
        }

        // Block up to 1s waiting for data (select so we can recheck the guard above)
        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(fd, &rfds);
        struct timeval tv = { 1, 0 };
        int r = select(fd + 1, &rfds, nullptr, nullptr, &tv);
        if (r <= 0) continue;

        ssize_t n = read(fd, buf, EV_SIZE);
        if (n < (ssize_t)EV_SIZE) continue;

        struct input_event ie;
        memcpy(&ie, buf, sizeof(ie));

        // EV_FF (0x15) with type FF_RUMBLE (0x50)
        if (ie.type != 0x15 || ie.code != 0x50) continue;

        float strong, weak;
        int   duration;
        if (ie.value > 0) {
            strong   = std::min(1.0f, ie.value / 65535.0f);
            weak     = strong * 0.6f;
            duration = 200;
        } else {
            strong = weak = 0.0f;
            duration = 0;
        }

        if (!g_tsfnValid) continue;

        // Pack into heap struct so the lambda captures it safely
        struct RumbleData {
            uint8_t slot; std::string viewerId;
            float strong, weak; int duration;
        };
        auto* rd = new RumbleData{ slot, viewerId, strong, weak, duration };

        g_rumbleTsfn.NonBlockingCall(rd, [](Napi::Env env, Napi::Function cb, RumbleData* rd) {
            Napi::Object obj = Napi::Object::New(env);
            obj.Set("slot",     Napi::Number::New(env, rd->slot));
            obj.Set("viewerId", Napi::String::New(env, rd->viewerId));
            obj.Set("strong",   Napi::Number::New(env, rd->strong));
            obj.Set("weak",     Napi::Number::New(env, rd->weak));
            obj.Set("duration", Napi::Number::New(env, rd->duration));
            cb.Call({ obj });
            delete rd;
        });
    }
    close(fd);
}

// ── Attach rumble watcher for a newly created gamepad ─────────────────────────
static void attach_rumble_watcher(uint8_t slot, const std::string& dev_name, const std::string& viewerId) {
    // Give kernel 300ms to register the sysfs entry (same as Python side)
    std::thread([slot, dev_name, viewerId]() {
        usleep(300000);
        std::string node = find_event_node(dev_name);
        if (node.empty()) return;

        int fd = open(node.c_str(), O_RDONLY | O_NONBLOCK);
        if (fd < 0) return;

        {
            std::lock_guard<std::mutex> lk(g_rumbleMtx);
            auto old = g_rumbleFds.find(slot);
            if (old != g_rumbleFds.end()) { close(old->second); }
            g_rumbleFds[slot]  = fd;
            g_padViewers[std::to_string(slot)] = viewerId;
        }
        rumble_watcher_thread(slot, fd, viewerId);
    }).detach();
}

// ── N-API: register JS rumble callback ────────────────────────────────────────
Napi::Value SetRumbleCallback(const Napi::CallbackInfo& info) {
    if (info.Length() < 1 || !info[0].IsFunction()) return info.Env().Undefined();
    if (g_tsfnValid) { g_rumbleTsfn.Release(); g_tsfnValid = false; }
    g_rumbleTsfn = RumbleTSFN::New(
        info.Env(), info[0].As<Napi::Function>(), "rumbleCallback", 0, 1
    );
    g_tsfnValid = true;
    return info.Env().Undefined();
}

// ── N-API: init mouse/keyboard device ─────────────────────────────────────────
Napi::Boolean InitializeDevice(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int screenW = info.Length() > 0 ? info[0].As<Napi::Number>().Int32Value() : 1920;
    int screenH = info.Length() > 1 ? info[1].As<Napi::Number>().Int32Value() : 1080;

    kbm_fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
    if (kbm_fd < 0) return Napi::Boolean::New(env, false);

    // EV_SYN must be registered explicitly on some kernel versions
    ioctl(kbm_fd, UI_SET_EVBIT, EV_SYN);

    // Keyboard
    ioctl(kbm_fd, UI_SET_EVBIT, EV_KEY);
    for (int i = 1; i < 255; i++) ioctl(kbm_fd, UI_SET_KEYBIT, i);

    // Mouse buttons
    ioctl(kbm_fd, UI_SET_KEYBIT, BTN_LEFT);
    ioctl(kbm_fd, UI_SET_KEYBIT, BTN_RIGHT);
    ioctl(kbm_fd, UI_SET_KEYBIT, BTN_MIDDLE);

    // Relative axes (mouse movement + scroll)
    ioctl(kbm_fd, UI_SET_EVBIT,  EV_REL);
    ioctl(kbm_fd, UI_SET_RELBIT, REL_X);
    ioctl(kbm_fd, UI_SET_RELBIT, REL_Y);
    ioctl(kbm_fd, UI_SET_RELBIT, REL_WHEEL);
    ioctl(kbm_fd, UI_SET_RELBIT, REL_HWHEEL);

    // Absolute axes removed from KBM to prevent SDL2 misidentifying it as a Gamepad

    struct uinput_user_dev uud = {};
    snprintf(uud.name, UINPUT_MAX_NAME_SIZE, "Nearsec Virtual KBM");
    uud.id.bustype = BUS_USB;
    uud.id.vendor  = 0x1234;
    uud.id.product = 0x5678;
    uud.id.version = 1;
    uud.id.version = 1;

    if (write(kbm_fd, &uud, sizeof(uud)) < 0) {
        close(kbm_fd); kbm_fd = -1;
        return Napi::Boolean::New(env, false);
    }
    ioctl(kbm_fd, UI_DEV_CREATE);
    return Napi::Boolean::New(env, true);
}

// ── N-API: fast-lane binary packet router ─────────────────────────────────────
Napi::Value SubmitInputPacket(const Napi::CallbackInfo& info) {
    if (!info[0].IsBuffer()) return info.Env().Undefined();

    Napi::Buffer<uint8_t> buffer = info[0].As<Napi::Buffer<uint8_t>>();
    uint8_t* data = buffer.Data();
    if (buffer.Length() < 1) return info.Env().Undefined();

    uint8_t type = data[0];

    switch (type) {

        // ── GAMEPAD STATE (16 bytes) ──────────────────────────────────────────
        case PKT::GAMEPAD: {
            uint8_t slot = data[15];
            auto it = gp_fds.find(slot);
            if (it == gp_fds.end()) break;
            int fd = it->second;

            int16_t  lx  = *reinterpret_cast<int16_t* >(&data[1]);
            int16_t  ly  = *reinterpret_cast<int16_t* >(&data[3]);
            int16_t  rx  = *reinterpret_cast<int16_t* >(&data[5]);
            int16_t  ry  = *reinterpret_cast<int16_t* >(&data[7]);
            uint8_t  lt  = data[9];
            uint8_t  rt  = data[10];
            uint16_t btn = *reinterpret_cast<uint16_t*>(&data[11]);
            int8_t   hx  = *reinterpret_cast<int8_t*  >(&data[13]);
            int8_t   hy  = *reinterpret_cast<int8_t*  >(&data[14]);

            emit(fd, EV_ABS, ABS_X,    lx);
            emit(fd, EV_ABS, ABS_Y,    ly);
            emit(fd, EV_ABS, ABS_RX,   rx);
            emit(fd, EV_ABS, ABS_RY,   ry);
            emit(fd, EV_ABS, ABS_Z,    lt);
            emit(fd, EV_ABS, ABS_RZ,   rt);
            emit(fd, EV_ABS, ABS_HAT0X, hx);
            emit(fd, EV_ABS, ABS_HAT0Y, hy);

            emit(fd, EV_KEY, BTN_SOUTH,  (btn & W3C_BTN::A)     ? 1 : 0);
            emit(fd, EV_KEY, BTN_EAST,   (btn & W3C_BTN::B)     ? 1 : 0);
            emit(fd, EV_KEY, BTN_WEST,   (btn & W3C_BTN::Y)     ? 1 : 0);
            emit(fd, EV_KEY, BTN_NORTH,  (btn & W3C_BTN::X)     ? 1 : 0);
            emit(fd, EV_KEY, BTN_TL,     (btn & W3C_BTN::LB)    ? 1 : 0);
            emit(fd, EV_KEY, BTN_TR,     (btn & W3C_BTN::RB)    ? 1 : 0);
            emit(fd, EV_KEY, BTN_SELECT, (btn & W3C_BTN::BACK)  ? 1 : 0);
            emit(fd, EV_KEY, BTN_START,  (btn & W3C_BTN::START) ? 1 : 0);
            emit(fd, EV_KEY, BTN_THUMBL, (btn & W3C_BTN::LS)    ? 1 : 0);
            emit(fd, EV_KEY, BTN_THUMBR, (btn & W3C_BTN::RS)    ? 1 : 0);
            emit(fd, EV_KEY, BTN_MODE,   (btn & W3C_BTN::GUIDE) ? 1 : 0);

            syn(fd);
            break;
        }

        // ── MOUSE RELATIVE ────────────────────────────────────────────────────
        case PKT::MOUSE_REL: {
            int16_t dx = *reinterpret_cast<int16_t*>(&data[1]);
            int16_t dy = *reinterpret_cast<int16_t*>(&data[3]);
            emit(kbm_fd, EV_REL, REL_X, dx);
            emit(kbm_fd, EV_REL, REL_Y, dy);
            syn(kbm_fd);
            break;
        }

        // ── MOUSE ABSOLUTE ────────────────────────────────────────────────────
        case PKT::MOUSE_ABS: {
            uint16_t nx = *reinterpret_cast<uint16_t*>(&data[1]);
            uint16_t ny = *reinterpret_cast<uint16_t*>(&data[3]);
            emit(kbm_fd, EV_ABS, ABS_X, nx);
            emit(kbm_fd, EV_ABS, ABS_Y, ny);
            syn(kbm_fd);
            break;
        }

        // ── MOUSE BUTTONS ─────────────────────────────────────────────────────
        case PKT::MOUSE_BTN: {
            uint8_t btns = data[1];
            uint8_t down = data[2];
            if (btns & 0x01) emit(kbm_fd, EV_KEY, BTN_LEFT,   down);
            if (btns & 0x02) emit(kbm_fd, EV_KEY, BTN_RIGHT,  down);
            if (btns & 0x04) emit(kbm_fd, EV_KEY, BTN_MIDDLE, down);
            syn(kbm_fd);
            break;
        }

        // ── SCROLL WHEEL ─────────────────────────────────────────────────────
        case PKT::WHEEL: {
            int16_t dy = *reinterpret_cast<int16_t*>(&data[1]);
            int16_t dx = *reinterpret_cast<int16_t*>(&data[3]);
            emit(kbm_fd, EV_REL, REL_WHEEL,  dy / 120);
            emit(kbm_fd, EV_REL, REL_HWHEEL, dx / 120);
            syn(kbm_fd);
            break;
        }

        // ── KEYBOARD KEY ─────────────────────────────────────────────────────
        case PKT::KEY: {
            uint16_t code = *reinterpret_cast<uint16_t*>(&data[1]);
            uint8_t  down = data[3];
            emit(kbm_fd, EV_KEY, code, down);
            syn(kbm_fd);
            break;
        }

        // ── ALLOC GAMEPAD SLOT ────────────────────────────────────────────────
        // Packet layout (40 bytes):
        //   [0]    = 0x10 (PKT::ALLOC_GP)
        //   [1]    = slot
        //   [2-3]  = vendor id  (uint16LE)
        //   [4-5]  = product id (uint16LE)
        //   [6-7]  = version    (uint16LE)
        //   [8-39] = device name (32 bytes, null-padded)
        case PKT::ALLOC_GP: {
            uint8_t  slot = data[1];
            uint16_t vid  = *reinterpret_cast<uint16_t*>(&data[2]);
            uint16_t pid  = *reinterpret_cast<uint16_t*>(&data[4]);
            uint16_t ver  = *reinterpret_cast<uint16_t*>(&data[6]);

            // Read device name from packet
            char dev_name[33] = {};
            memcpy(dev_name, &data[8], 32);
            std::string dev_name_str(dev_name);

            // Read optional viewerId from [40..103] if the caller wrote it
            // (InputOrchestrator currently doesn't — we fall back to slot string)
            std::string viewer_id = std::to_string(slot);

            // Destroy old slot if reusing
            auto old_it = gp_fds.find(slot);
            if (old_it != gp_fds.end()) {
                ioctl(old_it->second, UI_DEV_DESTROY);
                close(old_it->second);
                gp_fds.erase(old_it);
                gp_names.erase(slot);
                std::lock_guard<std::mutex> lk(g_rumbleMtx);
                auto rfd = g_rumbleFds.find(slot);
                if (rfd != g_rumbleFds.end()) { close(rfd->second); g_rumbleFds.erase(rfd); }
            }

            int fd = open("/dev/uinput", O_RDWR | O_NONBLOCK);
            if (fd < 0) break;

            // EV_SYN (explicit, some kernels require it)
            ioctl(fd, UI_SET_EVBIT, EV_SYN);

            // Buttons
            ioctl(fd, UI_SET_EVBIT,  EV_KEY);
            ioctl(fd, UI_SET_KEYBIT, BTN_SOUTH);  ioctl(fd, UI_SET_KEYBIT, BTN_EAST);
            ioctl(fd, UI_SET_KEYBIT, BTN_NORTH);  ioctl(fd, UI_SET_KEYBIT, BTN_WEST);
            ioctl(fd, UI_SET_KEYBIT, BTN_TL);     ioctl(fd, UI_SET_KEYBIT, BTN_TR);
            ioctl(fd, UI_SET_KEYBIT, BTN_SELECT); ioctl(fd, UI_SET_KEYBIT, BTN_START);
            ioctl(fd, UI_SET_KEYBIT, BTN_MODE);
            ioctl(fd, UI_SET_KEYBIT, BTN_THUMBL); ioctl(fd, UI_SET_KEYBIT, BTN_THUMBR);

            // Absolute axes
            ioctl(fd, UI_SET_EVBIT, EV_ABS);
            ioctl(fd, UI_SET_ABSBIT, ABS_X);    ioctl(fd, UI_SET_ABSBIT, ABS_Y);
            ioctl(fd, UI_SET_ABSBIT, ABS_RX);   ioctl(fd, UI_SET_ABSBIT, ABS_RY);
            ioctl(fd, UI_SET_ABSBIT, ABS_Z);    ioctl(fd, UI_SET_ABSBIT, ABS_RZ);
            ioctl(fd, UI_SET_ABSBIT, ABS_HAT0X); ioctl(fd, UI_SET_ABSBIT, ABS_HAT0Y);

            // Force Feedback
            ioctl(fd, UI_SET_EVBIT, EV_FF);
            ioctl(fd, UI_SET_FFBIT, FF_RUMBLE);

            // Build uinput_user_dev with fuzz/flat matching linux_uinput.py:
            //   sticks:   fuzz=16, flat=128  (prevents stick-drift noise)
            //   triggers: fuzz=0,  flat=0
            //   hat:      fuzz=0,  flat=0
            struct uinput_user_dev uud = {};
            set_abs(uud, ABS_X,    -32767, 32767, 16, 128);
            set_abs(uud, ABS_Y,    -32767, 32767, 16, 128);
            set_abs(uud, ABS_RX,   -32767, 32767, 16, 128);
            set_abs(uud, ABS_RY,   -32767, 32767, 16, 128);
            set_abs(uud, ABS_Z,         0,   255,  0,   0);
            set_abs(uud, ABS_RZ,        0,   255,  0,   0);
            set_abs(uud, ABS_HAT0X,    -1,     1,  0,   0);
            set_abs(uud, ABS_HAT0Y,    -1,     1,  0,   0);
            uud.ff_effects_max = 16;

            uud.id.bustype = BUS_USB;
            uud.id.vendor  = vid;
            uud.id.product = pid;
            uud.id.version = ver;
            memcpy(uud.name, dev_name, 32);

            if (write(fd, &uud, sizeof(uud)) < 0) {
                close(fd);
                break;
            }
            ioctl(fd, UI_DEV_CREATE);
            gp_fds[slot]   = fd;
            gp_names[slot] = dev_name_str;

            // Spawn background thread:
            //  1. ACK FF upload/erase so games never deadlock
            //  2. Intercept EV_FF play events (which come back to the write fd
            //     via uinput_dev_ff_playback) and fire the rumble callback.
            //
            // Key insight: EV_FF play events come back on the WRITE fd (fd),
            // NOT on the separate eventX read node. The old rumble_watcher was
            // looking in the wrong place.
            std::thread([fd, slot, viewer_id]() {
                // Per-slot effect magnitude table: effect_id -> {strong, weak}
                std::map<int, std::pair<uint16_t,uint16_t>> effect_mags;

                while (true) {
                    {
                        std::lock_guard<std::mutex> lk(g_rumbleMtx);
                        auto it = gp_fds.find(slot);
                        if (it == gp_fds.end() || it->second != fd) break;
                    }
                    fd_set rfds; FD_ZERO(&rfds); FD_SET(fd, &rfds);
                    struct timeval tv = { 1, 0 };
                    if (select(fd + 1, &rfds, nullptr, nullptr, &tv) <= 0) continue;

                    struct input_event ie;
                    if (read(fd, &ie, sizeof(ie)) < (ssize_t)sizeof(ie)) continue;

                    if (ie.type == EV_UINPUT) {
                        if (ie.code == UI_FF_UPLOAD) {
                            struct uinput_ff_upload req; memset(&req, 0, sizeof(req));
                            req.request_id = ie.value;
                            ioctl(fd, UI_BEGIN_FF_UPLOAD, &req);
                            // Store magnitudes so the EV_FF play event has values
                            if (req.effect.type == FF_RUMBLE) {
                                effect_mags[req.effect.id] = {
                                    req.effect.u.rumble.strong_magnitude,
                                    req.effect.u.rumble.weak_magnitude
                                };
                            }
                            req.retval = 0;
                            ioctl(fd, UI_END_FF_UPLOAD, &req);
                        } else if (ie.code == UI_FF_ERASE) {
                            struct uinput_ff_erase req; memset(&req, 0, sizeof(req));
                            req.request_id = ie.value;
                            ioctl(fd, UI_BEGIN_FF_ERASE, &req);
                            effect_mags.erase(req.effect_id);
                            req.retval = 0;
                            ioctl(fd, UI_END_FF_ERASE, &req);
                        }
                    } else if (ie.type == EV_FF) {
                        // EV_FF play command from the game — fire the rumble callback
                        if (!g_tsfnValid) continue;

                        float strong = 0.0f, weak = 0.0f;
                        int   duration = 200;

                        if (ie.value > 0) {
                            auto it = effect_mags.find(ie.code);
                            if (it != effect_mags.end()) {
                                strong = std::min(1.0f, it->second.first  / 65535.0f);
                                weak   = std::min(1.0f, it->second.second / 65535.0f);
                            } else {
                                // Unknown effect — use moderate defaults
                                strong = 0.5f; weak = 0.3f;
                            }
                        }
                        // ie.value == 0 means stop: strong=weak=0

                        std::string real_viewer;
                        {
                            std::lock_guard<std::mutex> lk(g_rumbleMtx);
                            auto vi = g_padViewers.find(std::to_string(slot));
                            if (vi != g_padViewers.end()) real_viewer = vi->second;
                        }

                        struct RumbleData {
                            uint8_t slot; std::string viewerId;
                            float strong, weak; int duration;
                        };
                        auto* rd = new RumbleData{ slot, real_viewer, strong, weak, duration };
                        g_rumbleTsfn.NonBlockingCall(rd, [](Napi::Env env, Napi::Function cb, RumbleData* rd) {
                            Napi::Object obj = Napi::Object::New(env);
                            obj.Set("slot",     Napi::Number::New(env, rd->slot));
                            obj.Set("viewerId", Napi::String::New(env, rd->viewerId));
                            obj.Set("strong",   Napi::Number::New(env, rd->strong));
                            obj.Set("weak",     Napi::Number::New(env, rd->weak));
                            obj.Set("duration", Napi::Number::New(env, rd->duration));
                            cb.Call({ obj });
                            delete rd;
                        });
                    }
                }
            }).detach();
            break;
        }

        // ── FREE GAMEPAD SLOT ─────────────────────────────────────────────────
        case PKT::FREE_GP: {
            uint8_t slot = data[1];
            auto it = gp_fds.find(slot);
            if (it != gp_fds.end()) {
                ioctl(it->second, UI_DEV_DESTROY);
                close(it->second);
                gp_fds.erase(it);
                gp_names.erase(slot);
            }
            {
                std::lock_guard<std::mutex> lk(g_rumbleMtx);
                auto rfd = g_rumbleFds.find(slot);
                if (rfd != g_rumbleFds.end()) { close(rfd->second); g_rumbleFds.erase(rfd); }
            }
            break;
        }

        // ── FLUSH (neutralise all axes/buttons) ───────────────────────────────
        case PKT::FLUSH: {
            uint8_t slot = data[1];
            auto it = gp_fds.find(slot);
            if (it == gp_fds.end()) break;
            int fd = it->second;
            emit(fd, EV_ABS, ABS_X,     0); emit(fd, EV_ABS, ABS_Y,     0);
            emit(fd, EV_ABS, ABS_RX,    0); emit(fd, EV_ABS, ABS_RY,    0);
            emit(fd, EV_ABS, ABS_Z,     0); emit(fd, EV_ABS, ABS_RZ,    0);
            emit(fd, EV_ABS, ABS_HAT0X, 0); emit(fd, EV_ABS, ABS_HAT0Y, 0);
            for (auto code : {BTN_SOUTH, BTN_EAST, BTN_WEST, BTN_NORTH,
                               BTN_TL, BTN_TR, BTN_SELECT, BTN_START,
                               BTN_MODE, BTN_THUMBL, BTN_THUMBR}) {
                emit(fd, EV_KEY, code, 0);
            }
            syn(fd);
            break;
        }

        // ── DESTROY ALL ───────────────────────────────────────────────────────
        case PKT::DESTROY: {
            for (auto& [slot, fd] : gp_fds) {
                ioctl(fd, UI_DEV_DESTROY);
                close(fd);
            }
            gp_fds.clear();
            gp_names.clear();
            if (kbm_fd >= 0) {
                ioctl(kbm_fd, UI_DEV_DESTROY);
                close(kbm_fd);
                kbm_fd = -1;
            }
            {
                std::lock_guard<std::mutex> lk(g_rumbleMtx);
                for (auto& [slot, fd] : g_rumbleFds) close(fd);
                g_rumbleFds.clear();
            }
            if (g_tsfnValid) { g_rumbleTsfn.Release(); g_tsfnValid = false; }
            break;
        }
    }
    return info.Env().Undefined();
}

// ── N-API: explicit destroy (called from JS destroy()) ───────────────────────
Napi::Value DestroyDevice(const Napi::CallbackInfo& info) {
    if (kbm_fd >= 0) { ioctl(kbm_fd, UI_DEV_DESTROY); close(kbm_fd); kbm_fd = -1; }
    for (auto& [slot, fd] : gp_fds) { ioctl(fd, UI_DEV_DESTROY); close(fd); }
    gp_fds.clear();
    gp_names.clear();
    {
        std::lock_guard<std::mutex> lk(g_rumbleMtx);
        for (auto& [slot, fd] : g_rumbleFds) close(fd);
        g_rumbleFds.clear();
    }
    if (g_tsfnValid) { g_rumbleTsfn.Release(); g_tsfnValid = false; }
    return info.Env().Undefined();
}

// ── Module init ───────────────────────────────────────────────────────────────
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("initializeDevice",  Napi::Function::New(env, InitializeDevice));
    exports.Set("submitInputPacket", Napi::Function::New(env, SubmitInputPacket));
    exports.Set("destroyDevice",     Napi::Function::New(env, DestroyDevice));
    exports.Set("setRumbleCallback", Napi::Function::New(env, SetRumbleCallback));
    return exports;
}

NODE_API_MODULE(uinputBridge, Init)
