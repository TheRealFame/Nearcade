/**
 * src/sidecar/capture/avcodec_encoder.cc
 * Hardware H264 encode as a Node N-API addon via libavcodec (VAAPI), in-process.
 *
 * Why this exists alongside vaapi_encoder.cc (raw libva): the raw path proved
 * every VAAPI mechanic works but hits flaky userspace crashes in radeonsi on
 * navi33 during sustained runs, while ffmpeg's libavcodec dialogue with the
 * same driver is rock solid (5+ min sustained, zero failures). This addon reuses
 * that exact proven path (libavcodec h264_vaapi + AVHWFramesContext) without
 * spawning ffmpeg processes: RGBA in, Annex-B H264 out, fully synchronous.
 *
 * Covers Intel (iHD/i965) + AMD (radeonsi) on Linux. NVIDIA needs an NVENC
 * backend; Windows/macOS need MF/VideoToolbox backends.
 *
 * JS API (mirrors vaapi_encoder):
 *   enc.info()                                         -> { ok, encoders:[...] }
 *   enc.init({ width, height, bitrate, fps, gop, device }) -> handle (int)
 *   enc.encode(handle, rgbaBuffer, keyFrameBool)       -> Buffer (Annex-B) | empty Buffer when encoder buffers
 *   enc.close(handle)                                  -> bool
 */
#include <napi.h>
#include <cstring>
#include <cstdint>
#include <string>
#include <vector>
#include <map>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
#include <libavutil/hwcontext.h>
#include <libavutil/hwcontext_vaapi.h>
#include <libavutil/imgutils.h>
}

namespace {

// BT.601 full-range RGBA -> NV12 (shared recipe with vaapi_encoder.cc).
void rgbaToNv12(const uint8_t *rgba, uint8_t *yPlane, uint8_t *uvPlane, int w, int h) {
    for (int y = 0; y < h; y += 2) {
        for (int x = 0; x < w; x += 2) {
            int u = 0, v = 0;
            for (int dy = 0; dy < 2; ++dy) {
                for (int dx = 0; dx < 2; ++dx) {
                    const uint8_t *p = rgba + ((y + dy) * w + (x + dx)) * 4;
                    int r = p[0], g = p[1], b = p[2];
                    int yy = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
                    yPlane[(y + dy) * w + (x + dx)] = (uint8_t)(yy < 0 ? 0 : (yy > 255 ? 255 : yy));
                    u += ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
                    v += ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
                }
            }
            int o = (y / 2) * w + x;
            int uu = u / 4, vv = v / 4;
            uvPlane[o] = (uint8_t)(uu < 0 ? 0 : (uu > 255 ? 255 : uu));
            uvPlane[o + 1] = (uint8_t)(vv < 0 ? 0 : (vv > 255 ? 255 : vv));
        }
    }
}

struct AvcSession {
    AVBufferRef *hwDevice = nullptr;
    AVCodecContext *enc = nullptr;
    AVBufferRef *hwFrames = nullptr;
    AVFrame *sw = nullptr;
    int width = 0, height = 0, fps = 30;
    int64_t pts = 0;
    std::string err;
};

static std::map<int, AvcSession *> g_sessions;
static int g_nextHandle = 1;

bool fail(Napi::Env env, const std::string &msg) {
    Napi::Error::New(env, msg).ThrowAsJavaScriptException();
    return false;
}

static void freeSession(AvcSession *s) {
    if (!s) return;
    av_frame_free(&s->sw);
    avcodec_free_context(&s->enc);
    av_buffer_unref(&s->hwFrames);
    av_buffer_unref(&s->hwDevice);
    delete s;
}

static bool optInt(Napi::Object o, const char *k, int &dst) {
    if (!o.Has(k)) return true;
    Napi::Value v = o.Get(k);
    if (!v.IsNumber()) return false;
    dst = (int)v.As<Napi::Number>().Int32Value();
    return true;
}

Napi::Value Info(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    Napi::Object out = Napi::Object::New(env);
    const AVCodec *c = avcodec_find_encoder_by_name("h264_vaapi");
    out.Set("ok", c != nullptr);
    out.Set("h264_vaapi", c != nullptr);
    out.Set("libavcodec", av_version_info());
    return out;
}

Napi::Value Init(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) { fail(env, "init(opts) required"); return env.Null(); }
    Napi::Object o = info[0].As<Napi::Object>();
    int width = 0, height = 0, bitrate = 4000000, fps = 30, gop = 0;
    if (!optInt(o, "width", width) || !optInt(o, "height", height) ||
        !optInt(o, "bitrate", bitrate) || !optInt(o, "fps", fps) || !optInt(o, "gop", gop)) {
        fail(env, "width/height/bitrate/fps/gop must be numbers"); return env.Null();
    }
    std::string device = "/dev/dri/renderD128";
    if (o.Has("device")) {
        Napi::Value v = o.Get("device");
        if (!v.IsString()) { fail(env, "device must be a string"); return env.Null(); }
        device = v.As<Napi::String>().Utf8Value();
    }
    if (width < 16 || height < 16 || (width % 2) || (height % 2)) { fail(env, "width/height must be even and >= 16"); return env.Null(); }
    if (fps < 1 || fps > 240) fps = 30;
    if (gop <= 0) gop = fps * 2;

    AvcSession *s = new AvcSession();
    s->width = width; s->height = height; s->fps = fps;

    const AVCodec *codec = avcodec_find_encoder_by_name("h264_vaapi");
    if (!codec) { delete s; fail(env, "h264_vaapi encoder not in libavcodec"); return env.Null(); }
    if (av_hwdevice_ctx_create(&s->hwDevice, AV_HWDEVICE_TYPE_VAAPI, device.c_str(), nullptr, 0) < 0) {
        delete s; fail(env, "av_hwdevice_ctx_create(vaapi) failed: " + device); return env.Null();
    }
    s->enc = avcodec_alloc_context3(codec);
    if (!s->enc) { freeSession(s); fail(env, "avcodec_alloc_context3 failed"); return env.Null(); }
    s->enc->width = width; s->enc->height = height;
    s->enc->time_base = AVRational{ 1, fps };
    s->enc->framerate = AVRational{ fps, 1 };
    s->enc->pix_fmt = AV_PIX_FMT_VAAPI;
    s->enc->bit_rate = bitrate;
    s->enc->gop_size = gop;
    s->enc->max_b_frames = 0; // low-latency IP pattern
    s->enc->refs = 1;

    s->hwFrames = av_hwframe_ctx_alloc(s->hwDevice);
    if (!s->hwFrames) { freeSession(s); fail(env, "av_hwframe_ctx_alloc failed"); return env.Null(); }
    AVHWFramesContext *fc = (AVHWFramesContext *)s->hwFrames->data;
    fc->format = AV_PIX_FMT_VAAPI;
    fc->sw_format = AV_PIX_FMT_NV12;
    fc->width = width; fc->height = height;
    if (av_hwframe_ctx_init(s->hwFrames) < 0) { freeSession(s); fail(env, "av_hwframe_ctx_init failed"); return env.Null(); }
    s->enc->hw_frames_ctx = av_buffer_ref(s->hwFrames);
    if (!s->enc->hw_frames_ctx) { freeSession(s); fail(env, "hw_frames_ctx ref failed"); return env.Null(); }

    if (avcodec_open2(s->enc, codec, nullptr) < 0) { freeSession(s); fail(env, "avcodec_open2(h264_vaapi) failed"); return env.Null(); }

    s->sw = av_frame_alloc();
    if (!s->sw) { freeSession(s); fail(env, "av_frame_alloc failed"); return env.Null(); }
    s->sw->format = AV_PIX_FMT_NV12;
    s->sw->width = width; s->sw->height = height;
    if (av_frame_get_buffer(s->sw, 0) < 0) { freeSession(s); fail(env, "sw frame buffer alloc failed"); return env.Null(); }

    int handle = g_nextHandle++;
    g_sessions[handle] = s;
    return Napi::Number::New(env, handle);
}

Napi::Value Encode(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsBuffer() || !info[2].IsBoolean()) {
        fail(env, "encode(handle, rgbaBuffer, keyFrame) required"); return env.Null();
    }
    int handle = (int)info[0].As<Napi::Number>().Int32Value();
    auto it = g_sessions.find(handle);
    if (it == g_sessions.end()) { fail(env, "bad handle"); return env.Null(); }
    AvcSession *s = it->second;
    Napi::Buffer<uint8_t> in = info[1].As<Napi::Buffer<uint8_t>>();
    bool wantKey = info[2].As<Napi::Boolean>().Value();
    size_t expect = (size_t)s->width * s->height * 4;
    if (in.Length() < expect) { fail(env, "rgba buffer too small"); return env.Null(); }

    if (av_frame_make_writable(s->sw) < 0) { fail(env, "sw frame not writable"); return env.Null(); }
    rgbaToNv12(in.Data(), s->sw->data[0], s->sw->data[1], s->width, s->height);
    s->sw->pts = s->pts++;

    AVFrame *hw = av_frame_alloc();
    if (!hw) { fail(env, "hw frame alloc failed"); return env.Null(); }
    if (av_hwframe_get_buffer(s->hwFrames, hw, 0) < 0) { av_frame_free(&hw); fail(env, "hwframe_get_buffer failed"); return env.Null(); }
    if (av_hwframe_transfer_data(hw, s->sw, 0) < 0) { av_frame_free(&hw); fail(env, "hwframe_transfer_data failed"); return env.Null(); }
    hw->pts = s->sw->pts;
    if (wantKey) hw->pict_type = AV_PICTURE_TYPE_I;

    int r = avcodec_send_frame(s->enc, hw);
    av_frame_free(&hw);
    if (r < 0) { fail(env, "avcodec_send_frame failed"); return env.Null(); }

    std::vector<uint8_t> out;
    for (;;) {
        AVPacket *pkt = av_packet_alloc();
        if (!pkt) { fail(env, "packet alloc failed"); return env.Null(); }
        r = avcodec_receive_packet(s->enc, pkt);
        if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) { av_packet_free(&pkt); break; }
        if (r < 0) { av_packet_free(&pkt); fail(env, "avcodec_receive_packet failed"); return env.Null(); }
        out.insert(out.end(), pkt->data, pkt->data + pkt->size);
        av_packet_free(&pkt);
    }
    if (out.empty()) return Napi::Buffer<uint8_t>::New(env, 0);
    return Napi::Buffer<uint8_t>::Copy(env, out.data(), out.size());
}

Napi::Value Close(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) { fail(env, "close(handle) required"); return env.Null(); }
    int handle = (int)info[0].As<Napi::Number>().Int32Value();
    auto it = g_sessions.find(handle);
    if (it == g_sessions.end()) return Napi::Boolean::New(env, false);
    // Drain encoder.
    avcodec_send_frame(it->second->enc, nullptr);
    for (;;) {
        AVPacket *pkt = av_packet_alloc();
        if (!pkt) break;
        if (avcodec_receive_packet(it->second->enc, pkt) < 0) { av_packet_free(&pkt); break; }
        av_packet_free(&pkt);
    }
    freeSession(it->second);
    g_sessions.erase(it);
    return Napi::Boolean::New(env, true);
}

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
    exports.Set("info", Napi::Function::New(env, Info));
    exports.Set("init", Napi::Function::New(env, Init));
    exports.Set("encode", Napi::Function::New(env, Encode));
    exports.Set("close", Napi::Function::New(env, Close));
    return exports;
}

NODE_API_MODULE(avcodec_encoder, InitModule)

} // namespace
