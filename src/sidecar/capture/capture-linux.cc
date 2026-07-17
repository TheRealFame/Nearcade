// Linux KMS/DRM GPU-direct capture addon
// Captures the primary display framebuffer directly via DRM, bypassing any
// display server (X11/Wayland). Uses drmModeGetFB2 + prime handle to DMA-BUF
// fd for zero-copy readback where possible.
//
// N-API interface: startCapture(monitorIndex) -> { width, height }
//                  getFrame() -> Buffer (RGBA 8bpc)
//                  stopCapture()
//                  getFrameSize() -> { width, height }

#include <napi.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <xf86drm.h>
#include <xf86drmMode.h>
#include <cstring>
#include <vector>
#include <string>
#include <cerrno>

struct CaptureSession {
    int fd = -1;
    uint32_t crtc_id = 0;
    uint32_t fb_id = 0;
    uint32_t last_fb_id = 0;
    int width = 0;
    int height = 0;
    size_t stride = 0;
    size_t size = 0;
    int dma_buf_fd = -1;
    void* map = nullptr;
    std::vector<uint8_t> lastFrame;
    bool hasFrame = false;
};

static CaptureSession* g_session = nullptr;

static const char* drmDevicePath(int card) {
    static char path[32];
    snprintf(path, sizeof(path), "/dev/dri/card%d", card);
    return path;
}

// Find a suitable DRM device with a connected display
static int findDisplayDevice(int& out_card, uint32_t& out_connector_id, uint32_t& out_crtc_id, int& out_width, int& out_height) {
    for (int card = 0; card < 8; card++) {
        const char* devPath = drmDevicePath(card);
        int fd = open(devPath, O_RDWR | O_CLOEXEC);
        if (fd < 0) continue;

        drmModeRes* res = drmModeGetResources(fd);
        if (!res) { close(fd); continue; }

        for (int c = 0; c < res->count_connectors; c++) {
            drmModeConnector* conn = drmModeGetConnector(fd, res->connectors[c]);
            if (!conn) continue;
            if (conn->connection != DRM_MODE_CONNECTED || conn->count_modes == 0) {
                drmModeFreeConnector(conn);
                continue;
            }

            drmModeEncoder* enc = nullptr;
            for (int e = 0; e < res->count_encoders; e++) {
                if (res->encoders[e] == conn->encoders[0]) {
                    enc = drmModeGetEncoder(fd, res->encoders[e]);
                    break;
                }
            }
            if (!enc) { drmModeFreeConnector(conn); continue; }

            drmModeCrtc* crtc = drmModeGetCrtc(fd, enc->crtc_id);
            drmModeFreeEncoder(enc);
            if (!crtc || !crtc->buffer_id) {
                if (crtc) drmModeFreeCrtc(crtc);
                drmModeFreeConnector(conn);
                continue;
            }

            out_card = card;
            out_connector_id = res->connectors[c];
            out_crtc_id = crtc->crtc_id;
            out_width = crtc->width;
            out_height = crtc->height;

            drmModeFreeCrtc(crtc);
            drmModeFreeConnector(conn);
            drmModeFreeResources(res);
            close(fd);
            return 0;
        }

        drmModeFreeResources(res);
        close(fd);
    }
    return -1;
}

static void unmapFrame() {
    if (!g_session) return;
    if (g_session->map && g_session->map != MAP_FAILED) munmap(g_session->map, g_session->size);
    if (g_session->dma_buf_fd >= 0) close(g_session->dma_buf_fd);
    g_session->map = nullptr;
    g_session->dma_buf_fd = -1;
    g_session->last_fb_id = 0;
}

static bool refreshMapping() {
    if (!g_session || g_session->fd < 0) return false;

    // If we already have a valid mapping, keep using it
    if (g_session->map && g_session->map != MAP_FAILED) return true;

    // No mapping yet — try DMA-BUF via drmModeGetFB2 + prime handle
    drmModeCrtc* crtc = drmModeGetCrtc(g_session->fd, g_session->crtc_id);
    if (crtc && crtc->buffer_id) {
        g_session->width = crtc->width;
        g_session->height = crtc->height;
        uint32_t current_fb = crtc->buffer_id;
        drmModeFreeCrtc(crtc);

        drmModeFB2* fb = drmModeGetFB2(g_session->fd, current_fb);
        if (fb) {
            if (fb->handles[0] > 0) {
                int ret = drmPrimeHandleToFD(g_session->fd, fb->handles[0], DRM_CLOEXEC, &g_session->dma_buf_fd);
                if (ret == 0 && g_session->dma_buf_fd >= 0) {
                    g_session->stride = fb->pitches[0];
                    g_session->size = g_session->height * g_session->stride;
                    g_session->map = mmap(nullptr, g_session->size, PROT_READ, MAP_SHARED, g_session->dma_buf_fd, 0);
                    if (g_session->map != MAP_FAILED) {
                        g_session->last_fb_id = current_fb;
                        drmModeFreeFB2(fb);
                        return true;
                    }
                    close(g_session->dma_buf_fd);
                    g_session->dma_buf_fd = -1;
                }
            }
            drmModeFreeFB2(fb);
        }
    } else if (crtc) {
        drmModeFreeCrtc(crtc);
    }

    // DMA-BUF failed — return false; caller should fall back to Portal
    return false;
}

static void releaseSession() {
    if (!g_session) return;
    unmapFrame();
    if (g_session->fd >= 0) close(g_session->fd);
    delete g_session;
    g_session = nullptr;
}

Napi::Value StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int monitorIndex = 0;
    if (info.Length() > 0 && info[0].IsNumber()) monitorIndex = info[0].As<Napi::Number>().Int32Value();

    releaseSession();
    g_session = new CaptureSession();

    int card, width, height;
    uint32_t conn_id, crtc_id;
    if (findDisplayDevice(card, conn_id, crtc_id, width, height) < 0) {
        delete g_session;
        g_session = nullptr;
        Napi::TypeError::New(env, "No connected display found via DRM").ThrowAsJavaScriptException();
        return env.Null();
    }

    g_session->fd = open(drmDevicePath(card), O_RDWR | O_CLOEXEC);
    if (g_session->fd < 0) {
        delete g_session;
        g_session = nullptr;
        Napi::TypeError::New(env, std::string("Cannot open DRM device: ") + strerror(errno)).ThrowAsJavaScriptException();
        return env.Null();
    }

    g_session->crtc_id = crtc_id;
    g_session->width = width;
    g_session->height = height;

    // Initial mapping of current scanout buffer
    if (!refreshMapping()) {
        releaseSession();
        Napi::TypeError::New(env, "Failed to map initial scanout buffer via DRM").ThrowAsJavaScriptException();
        return env.Null();
    }

    g_session->lastFrame.resize(g_session->width * g_session->height * 4);
    g_session->hasFrame = true;

    Napi::Object result = Napi::Object::New(env);
    result.Set("width", Napi::Number::New(env, g_session->width));
    result.Set("height", Napi::Number::New(env, g_session->height));
    return result;
}

static bool captureFrame() {
    if (!g_session || !g_session->map || g_session->map == MAP_FAILED) return false;

    const uint8_t* src = static_cast<const uint8_t*>(g_session->map);
    uint8_t* dst = g_session->lastFrame.data();
    int w = g_session->width;
    int h = g_session->height;
    size_t srcStride = g_session->stride;

    // Convert from likely BGRX/BGRA to RGBA
    for (int y = 0; y < h; y++) {
        const uint8_t* row = src + y * srcStride;
        int di = y * w * 4;
        for (int x = 0; x < w; x++) {
            int si = x * 4;
            dst[di + 0] = row[si + 2]; // R
            dst[di + 1] = row[si + 1]; // G
            dst[di + 2] = row[si + 0]; // B
            dst[di + 3] = 255;         // A
        }
    }
    return true;
}

Napi::Value GetFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!g_session || !g_session->hasFrame) return env.Null();

    if (!refreshMapping()) return env.Null();

    captureFrame();
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

NODE_API_MODULE(capture_linux, Init)
