// #11: Windows Raw Input gamepad reader addon
// Reads physical gamepad state via Raw Input API instead of browser Gamepad API.
// Delivers input events as they happen (WM_INPUT) with no polling overhead.

#include <napi.h>
#include <windows.h>
#include <hidsdi.h>
#include <setupapi.h>
#include <cfgmgr32.h>
#include <vector>
#include <unordered_map>
#include <functional>
#include <thread>
#include <mutex>

#pragma comment(lib, "hid.lib")
#pragma comment(lib, "setupapi.lib")

struct DeviceState {
    HANDLE handle;
    wchar_t devicePath[256];
    uint8_t buttons[16];
    int16_t axes[6]; // X, Y, Z, Rx, Ry, Rz
    uint8_t hat;
    bool connected;
};

static std::unordered_map<HANDLE, DeviceState> g_devices;
static std::mutex g_mutex;
static Napi::ThreadSafeFunction g_tsfn;
static bool g_running = false;
static HWND g_hwnd = nullptr;

static void RegisterRawInputDevices() {
    std::vector<RAWINPUTDEVICE> devices;
    
    // Get all HID devices
    SP_DEVINFO_DATA devInfoData;
    devInfoData.cbSize = sizeof(SP_DEVINFO_DATA);
    HDEVINFO devInfoSet = SetupDiGetClassDevs(
        &GUID_DEVINTERFACE_HID, nullptr, nullptr,
        DIGCF_PRESENT | DIGCF_DEVICEINTERFACE
    );

    if (devInfoSet == INVALID_HANDLE_VALUE) return;

    SP_DEVICE_INTERFACE_DATA ifcData;
    ifcData.cbSize = sizeof(SP_DEVICE_INTERFACE_DATA);
    
    for (DWORD i = 0; SetupDiEnumDeviceInterfaces(devInfoSet, nullptr,
         &GUID_DEVINTERFACE_HID, i, &ifcData); i++) {
        
        DWORD size = 0;
        SetupDiGetDeviceInterfaceDetail(devInfoSet, &ifcData, nullptr, 0, &size, nullptr);
        if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) continue;

        auto detail = (PSP_DEVICE_INTERFACE_DETAIL_DATA)malloc(size);
        detail->cbSize = sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA);
        if (!SetupDiGetDeviceInterfaceDetail(devInfoSet, &ifcData, detail, size, nullptr, nullptr)) {
            free(detail);
            continue;
        }

        HANDLE h = CreateFile(
            detail->DevicePath, GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            nullptr, OPEN_EXISTING, 0, nullptr
        );

        if (h != INVALID_HANDLE_VALUE) {
            // Check if it's a gamepad (usage page 1, usage 5)
            HIDD_ATTRIBUTES attr = { sizeof(HIDD_ATTRIBUTES) };
            if (HidD_GetAttributes(h, &attr)) {
                PHIDP_PREPARSED_DATA ppData = nullptr;
                if (HidD_GetPreparsedData(h, &ppData)) {
                    HIDP_CAPS caps;
                    if (HidP_GetCaps(ppData, &caps) == HIDP_STATUS_SUCCESS) {
                        if (caps.UsagePage == 1 && caps.Usage == 5) {
                            RAWINPUTDEVICE rid = {};
                            rid.usUsagePage = caps.UsagePage;
                            rid.usUsage = caps.Usage;
                            rid.dwFlags = RIDEV_INPUTSINK;
                            rid.hwndTarget = g_hwnd;
                            devices.push_back(rid);

                            DeviceState state = {};
                            state.handle = h;
                            wcscpy_s(state.devicePath, detail->DevicePath);
                            state.connected = true;
                            g_devices[h] = state;
                        }
                    }
                    HidD_FreePreparsedData(ppData);
                }
            }
        }
        free(detail);
    }
    SetupDiDestroyDeviceInfoList(devInfoSet);

    RegisterRawInputDevices(devices.data(), devices.size(), sizeof(RAWINPUTDEVICE));
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (msg == WM_INPUT) {
        UINT size = 0;
        GetRawInputData((HRAWINPUT)lParam, RID_INPUT, nullptr, &size, sizeof(RAWINPUTHEADER));
        std::vector<uint8_t> buf(size);
        if (GetRawInputData((HRAWINPUT)lParam, RID_INPUT, buf.data(), &size, sizeof(RAWINPUTHEADER)) == size) {
            RAWINPUT* raw = (RAWINPUT*)buf.data();
            if (raw->header.dwType == RIM_TYPEHID) {
                std::lock_guard<std::mutex> lock(g_mutex);
                auto it = g_devices.find(raw->header.hDevice);
                if (it != g_devices.end()) {
                    // Parse HID report and extract button/axis state
                    // Simplified: forward raw for JS parsing
                    if (g_tsfn) {
                        Napi::Buffer<uint8_t> napiBuf = Napi::Buffer<uint8_t>::New(
                            g_tsfn.Env(), raw->data.hid.bRawData, raw->data.hid.dwSizeHidInput
                        );
                        g_tsfn.BlockingCall([napiBuf](Napi::Env env, Napi::Function jsCallback) {
                            jsCallback.Call({ napiBuf });
                        });
                    }
                }
            }
        }
        return 0;
    }
    return DefWindowProc(hwnd, msg, wParam, lParam);
}

Napi::Value StartRawInput(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (g_running) return env.Undefined();

    // Create hidden window for Raw Input messages
    WNDCLASSEX wc = {};
    wc.cbSize = sizeof(WNDCLASSEX);
    wc.lpfnWndProc = WndProc;
    wc.hInstance = GetModuleHandle(nullptr);
    wc.lpszClassName = L"RawInputGamepadWindow";
    RegisterClassEx(&wc);

    g_hwnd = CreateWindowEx(0, L"RawInputGamepadWindow", L"Raw Input",
        WS_OVERLAPPEDWINDOW, 0, 0, 0, 0, nullptr, nullptr, wc.hInstance, nullptr);

    if (!g_hwnd) {
        Napi::TypeError::New(env, "Failed to create Raw Input window").ThrowAsJavaScriptException();
        return env.Null();
    }

    RegisterRawInputDevices();
    g_running = true;
    
    // Message pump thread
    std::thread([&]() {
        MSG msg;
        while (g_running && GetMessage(&msg, g_hwnd, 0, 0)) {
            TranslateMessage(&msg);
            DispatchMessage(&msg);
        }
    }).detach();

    return Napi::Boolean::New(env, true);
}

Napi::Value StopRawInput(const Napi::CallbackInfo& info) {
    g_running = false;
    if (g_hwnd) {
        DestroyWindow(g_hwnd);
        g_hwnd = nullptr;
    }
    std::lock_guard<std::mutex> lock(g_mutex);
    for (auto& [h, _] : g_devices) CloseHandle(h);
    g_devices.clear();
    return info.Env().Undefined();
}

Napi::Value GetDeviceCount(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> lock(g_mutex);
    return Napi::Number::New(info.Env(), g_devices.size());
}

Napi::Value SetCallback(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "Function expected").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    g_tsfn = Napi::ThreadSafeFunction::New(
        env, info[0].As<Napi::Function>(), "RawInputCallback", 0, 1
    );
    
    return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("start", Napi::Function::New(env, StartRawInput));
    exports.Set("stop", Napi::Function::New(env, StopRawInput));
    exports.Set("getDeviceCount", Napi::Function::New(env, GetDeviceCount));
    exports.Set("setCallback", Napi::Function::New(env, SetCallback));
    return exports;
}

NODE_API_MODULE(rawinput_win, Init)
