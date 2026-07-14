// #10: DXGI Desktop Duplication capture addon (Windows)
// Captures the desktop framebuffer directly from the GPU, bypassing DWM compositor.
// N-API interface: startCapture(monitorIndex) -> { getFrame() -> Buffer }

#include <napi.h>
#include <windows.h>
#include <dxgi.h>
#include <dxgi1_2.h>
#include <d3d11.h>
#include <comdef.h>
#include <vector>
#include <cstdint>

struct CaptureSession {
    IDXGIOutputDuplication* dup = nullptr;
    ID3D11Device* device = nullptr;
    ID3D11DeviceContext* context = nullptr;
    ID3D11Texture2D* stagingTex = nullptr;
    int width = 0;
    int height = 0;
    std::vector<uint8_t> lastFrame;
    bool hasFrame = false;
};

static CaptureSession* g_session = nullptr;

static void releaseSession() {
    if (!g_session) return;
    if (g_session->dup) g_session->dup->Release();
    if (g_session->stagingTex) g_session->stagingTex->Release();
    if (g_session->context) g_session->context->Release();
    if (g_session->device) g_session->device->Release();
    delete g_session;
    g_session = nullptr;
}

Napi::Value StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int monitorIndex = 0;
    if (info.Length() > 0 && info[0].IsNumber()) monitorIndex = info[0].As<Napi::Number>().Int32Value();

    releaseSession();
    g_session = new CaptureSession();

    HRESULT hr;

    // Create D3D11 device
    hr = D3D11CreateDevice(
        nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
        D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
        nullptr, 0, D3D11_SDK_VERSION,
        &g_session->device, nullptr, &g_session->context
    );
    if (FAILED(hr)) {
        releaseSession();
        Napi::TypeError::New(env, "D3D11CreateDevice failed").ThrowAsJavaScriptException();
        return env.Null();
    }

    // Create DXGI factory
    IDXGIFactory1* factory = nullptr;
    hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void**)&factory);
    if (FAILED(hr)) {
        releaseSession();
        Napi::TypeError::New(env, "CreateDXGIFactory1 failed").ThrowAsJavaScriptException();
        return env.Null();
    }

    // Find the adapter and output
    IDXGIAdapter* adapter = nullptr;
    IDXGIOutput* output = nullptr;
    int outputIndex = 0;
    for (int a = 0; factory->EnumAdapters(a, &adapter) != DXGI_ERROR_NOT_FOUND; a++) {
        for (int o = 0; adapter->EnumOutputs(o, &output) != DXGI_ERROR_NOT_FOUND; o++) {
            if (outputIndex == monitorIndex) goto found;
            output->Release();
            output = nullptr;
            outputIndex++;
        }
        adapter->Release();
        adapter = nullptr;
    }
    factory->Release();
    releaseSession();
    Napi::TypeError::New(env, "Monitor not found").ThrowAsJavaScriptException();
    return env.Null();

found:
    factory->Release();
    adapter->Release();

    // Get output description for resolution
    DXGI_OUTPUT_DESC outputDesc;
    output->GetDesc(&outputDesc);
    g_session->width = outputDesc.DesktopCoordinates.right - outputDesc.DesktopCoordinates.left;
    g_session->height = outputDesc.DesktopCoordinates.bottom - outputDesc.DesktopCoordinates.top;

    // Create output duplication
    IDXGIOutput1* output1 = nullptr;
    output->QueryInterface(__uuidof(IDXGIOutput1), (void**)&output1);
    output->Release();
    if (!output1) {
        releaseSession();
        Napi::TypeError::New(env, "QueryInterface for IDXGIOutput1 failed").ThrowAsJavaScriptException();
        return env.Null();
    }

    hr = output1->DuplicateOutput(g_session->device, &g_session->dup);
    output1->Release();
    if (FAILED(hr)) {
        releaseSession();
        Napi::TypeError::New(env, "DuplicateOutput failed").ThrowAsJavaScriptException();
        return env.Null();
    }

    // Create staging texture for CPU readback
    D3D11_TEXTURE2D_DESC texDesc = {};
    texDesc.Width = g_session->width;
    texDesc.Height = g_session->height;
    texDesc.MipLevels = 1;
    texDesc.ArraySize = 1;
    texDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    texDesc.SampleDesc.Count = 1;
    texDesc.Usage = D3D11_USAGE_STAGING;
    texDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    texDesc.BindFlags = 0;
    hr = g_session->device->CreateTexture2D(&texDesc, nullptr, &g_session->stagingTex);
    if (FAILED(hr)) {
        releaseSession();
        Napi::TypeError::New(env, "CreateTexture2D staging failed").ThrowAsJavaScriptException();
        return env.Null();
    }

    g_session->lastFrame.resize(g_session->width * g_session->height * 4);
    g_session->hasFrame = true;

    Napi::Object result = Napi::Object::New(env);
    result.Set("width", Napi::Number::New(env, g_session->width));
    result.Set("height", Napi::Number::New(env, g_session->height));
    return result;
}

Napi::Value GetFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_session || !g_session->hasFrame) return env.Null();

    IDXGIResource* desktopResource = nullptr;
    DXGI_OUTDUPL_FRAME_INFO frameInfo;

    HRESULT hr = g_session->dup->AcquireNextFrame(0, &frameInfo, &desktopResource);
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
        // No new frame — return cached last frame
        return Napi::Buffer<uint8_t>::Copy(env, g_session->lastFrame.data(), g_session->lastFrame.size());
    }
    if (FAILED(hr)) {
        if (hr == DXGI_ERROR_ACCESS_LOST) {
            // Desktop switch occurred — caller should reinitialize
            return Napi::Boolean::New(env, false);
        }
        return env.Null();
    }

    ID3D11Texture2D* gpuTex = nullptr;
    hr = desktopResource->QueryInterface(__uuidof(ID3D11Texture2D), (void**)&gpuTex);
    desktopResource->Release();
    if (FAILED(hr)) {
        g_session->dup->ReleaseFrame();
        return env.Null();
    }

    // Copy GPU texture to staging texture
    g_session->context->CopyResource(g_session->stagingTex, gpuTex);
    gpuTex->Release();

    // Map staging texture for CPU read
    D3D11_MAPPED_SUBRESOURCE mapped;
    hr = g_session->context->Map(g_session->stagingTex, 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(hr)) {
        g_session->dup->ReleaseFrame();
        return env.Null();
    }

    // Copy to our buffer (BGRX -> RGBA conversion)
    const uint8_t* src = static_cast<const uint8_t*>(mapped.pData);
    uint8_t* dst = g_session->lastFrame.data();
    for (int y = 0; y < g_session->height; y++) {
        for (int x = 0; x < g_session->width; x++) {
            int si = y * mapped.RowPitch + x * 4;
            int di = (y * g_session->width + x) * 4;
            dst[di + 0] = src[si + 2]; // R
            dst[di + 1] = src[si + 1]; // G
            dst[di + 2] = src[si + 0]; // B
            dst[di + 3] = 255;         // A
        }
    }

    g_session->context->Unmap(g_session->stagingTex, 0);
    g_session->dup->ReleaseFrame();

    return Napi::Buffer<uint8_t>::Copy(env, g_session->lastFrame.data(), g_session->lastFrame.size());
}

Napi::Value StopCapture(const Napi::CallbackInfo& info) {
    releaseSession();
    return info.Env().Undefined();
}

Napi::Value GetFrameSize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_session) {
        Napi::Object r = Napi::Object::New(env);
        r.Set("width", Napi::Number::New(env, 0));
        r.Set("height", Napi::Number::New(env, 0));
        return r;
    }
    Napi::Object result = Napi::Object::New(env);
    result.Set("width", Napi::Number::New(env, g_session->width));
    result.Set("height", Napi::Number::New(env, g_session->height));
    return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("startCapture", Napi::Function::New(env, StartCapture));
    exports.Set("getFrame", Napi::Function::New(env, GetFrame));
    exports.Set("stopCapture", Napi::Function::New(env, StopCapture));
    exports.Set("getFrameSize", Napi::Function::New(env, GetFrameSize));
    return exports;
}

NODE_API_MODULE(capture_win, Init)
