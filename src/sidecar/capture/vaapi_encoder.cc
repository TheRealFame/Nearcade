/**
 * src/sidecar/capture/vaapi_encoder.cc
 * Minimal VAAPI H.264 encoder as a Node N-API addon (no ffmpeg/GStreamer/Chromium).
 *
 * Covers Intel (iHD/i965) + AMD (radeonsi) on Linux via libva. NVIDIA needs a
 * separate NVENC backend; Windows/macOS need MF/VideoToolbox backends.
 *
 * JS API:
 *   const enc = require('vaapi_encoder.node');
 *   enc.info()                                            -> { ok, driver, profiles }
 *   enc.init({ width, height, bitrate, fps, device })     -> handle (int)
 *   enc.encode(handle, rgbaBuffer, keyFrameBool)          -> Buffer (Annex-B H264) | null on error
 *   enc.close(handle)                                     -> bool
 *
 * Notes:
 * - Input is packed RGBA (canvas / desktop capture format). Converted to NV12
 *   in C++ and uploaded with vaPutImage. Zero-copy DMA-BUF import is future work.
 * - SPS/PPS are hand-built to match the encoder config (no packed headers);
 *   slice headers come from the driver. Output is Annex-B (00 00 00 01).
 * - Synchronous calls; each encode blocks ~2-10ms. An AsyncWorker variant can
 *   be added if the event loop ever becomes the bottleneck.
 * - Matches repo convention: no C++ exceptions (NAPI_DISABLE_CPP_EXCEPTIONS).
 */
#include <napi.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstdio>
#include <cstring>
#include <cstdint>
#include <string>
#include <vector>
#include <map>

#include <va/va.h>
#include <va/va_drm.h>
#include <va/va_enc_h264.h>

// Stage tracing for hangs: set VAAPI_DEBUG=1 in the environment.
static void vdbg(const char *stage) {
    if (getenv("VAAPI_DEBUG")) { fprintf(stderr, "[vaapi-enc] %s\n", stage); fflush(stderr); }
}

namespace {

const int kNumSurfaces = 4;

struct BitWriter {
    std::vector<uint8_t> out;
    uint32_t cur = 0;
    int nbits = 0;
    void putBit(int b) { cur = (cur << 1) | (b & 1); if (++nbits == 8) { out.push_back((uint8_t)cur); cur = 0; nbits = 0; } }
    void putBits(uint32_t v, int n) { for (int i = n - 1; i >= 0; --i) putBit((v >> i) & 1); }
    void putUe(uint32_t v) {
        uint32_t c = v + 1; int n = 0; uint32_t t = c;
        while (t >>= 1) ++n;
        for (int i = 0; i < n; ++i) putBit(0);
        putBits(c, n + 1);
    }
    void putSe(int32_t v) { putUe(v <= 0 ? (uint32_t)(-2 * v) : (uint32_t)(2 * v - 1)); }
    void rbspTrailing() { putBit(1); while (nbits) putBit(0); }
};

// Annex-B framing with emulation prevention.
void appendNal(std::vector<uint8_t> &dst, uint8_t nalType, uint8_t nalRefIdc, const std::vector<uint8_t> &rbsp) {
    dst.push_back(0); dst.push_back(0); dst.push_back(0); dst.push_back(1);
    uint8_t hdr = (uint8_t)((0 << 7) | ((nalRefIdc & 3) << 5) | (nalType & 31));
    // Emulation prevention over header+rbsp.
    std::vector<uint8_t> raw; raw.reserve(1 + rbsp.size());
    raw.push_back(hdr);
    raw.insert(raw.end(), rbsp.begin(), rbsp.end());
    int zeros = 0;
    for (size_t i = 0; i < raw.size(); ++i) {
        if (zeros >= 2 && raw[i] <= 3) { dst.push_back(3); zeros = 0; }
        dst.push_back(raw[i]);
        zeros = (raw[i] == 0) ? zeros + 1 : 0;
    }
}

struct EncSession {
    int drmFd = -1;
    VADisplay dpy = nullptr;
    VAConfigID config = VA_INVALID_ID;
    VAContextID ctx = VA_INVALID_ID;
    VASurfaceID surfaces[kNumSurfaces] = { VA_INVALID_SURFACE };
    VASurfaceID recon[kNumSurfaces] = { VA_INVALID_SURFACE };
    // Persistent per-frame parameter buffers (ffmpeg model): created once,
    // updated in place via map/unmap, never churned. Per-frame create/destroy
    // churn trips flaky driver crashes on navi33.
    VABufferID bSeq = VA_INVALID_ID, bPic = VA_INVALID_ID, bSlice = VA_INVALID_ID;
    VABufferID bRc = VA_INVALID_ID, bHrd = VA_INVALID_ID, bFr = VA_INVALID_ID;
    VABufferID bPackSeqP = VA_INVALID_ID, bPackSeqD = VA_INVALID_ID;
    VABufferID bPackPicP = VA_INVALID_ID, bPackPicD = VA_INVALID_ID;
    VABufferID bPackSliceP = VA_INVALID_ID, bPackSliceD = VA_INVALID_ID;
    VABufferID codedBuf = VA_INVALID_ID;
    VAImage uploadImg;
    bool uploadImgValid = false;
    VAProfile profile = VAProfileH264High;
    int width = 0, height = 0, mbW = 0, mbH = 0;
    int encW = 0, encH = 0; // 16-aligned encode dims (driver/SPS DiM)
    int cropRight = 0, cropBottom = 0; // in 2px crop units
    int bitrate = 4000000, fps = 30, idrPeriod = 60;
    int frameCount = 0, idrCount = 0, nextSurf = 0, nextRecon = 0;
    unsigned packedMask = 0;
    std::vector<VABufferID> frameBufs;
    VASurfaceID refSurf = VA_INVALID_SURFACE;
    int refFrameNum = 0, refPoc = 0;
    std::vector<uint8_t> nv12scratch;
    std::vector<uint8_t> spsAnnexB, ppsAnnexB;

    bool buildHeaders(std::string &err);
};

bool EncSession::buildHeaders(std::string &err) {
    int profileIdc = 100;
    bool baseline = false;
    if (profile == VAProfileH264ConstrainedBaseline) { profileIdc = 66; baseline = true; }
    else if (profile == VAProfileH264Main) { profileIdc = 77; }
    // ---- SPS ----
    BitWriter s;
    s.putBits((uint32_t)profileIdc, 8);
    s.putBits(baseline ? 0xE0u : 0u, 8); // constraint flags
    s.putBits(42, 8);                    // level_idc 4.2
    s.putUe(0);                          // seq_parameter_set_id
    s.putUe(0);                          // log2_max_frame_num_minus4
    s.putUe(0);                          // pic_order_cnt_type
    s.putUe(1);                          // log2_max_pic_order_cnt_lsb_minus4
    s.putUe(1);                          // num_ref_frames (DPB size 1)
    s.putBits(0, 1);                     // gaps_in_frame_num_value_allowed_flag
    s.putUe((uint32_t)(mbW - 1));        // pic_width_in_mbs_minus1
    s.putUe((uint32_t)(mbH - 1));        // pic_height_in_map_units_minus1
    s.putBits(1, 1);                     // frame_mbs_only_flag
    s.putBits(1, 1);                     // direct_8x8_inference_flag
    if (this->cropRight || this->cropBottom) {
        s.putBits(1, 1);                 // frame_cropping_flag
        s.putUe(0);                      // crop_left
        s.putUe((uint32_t)this->cropRight); // crop_right (2px units)
        s.putUe(0);                      // crop_top
        s.putUe((uint32_t)this->cropBottom);// crop_bottom (2px units)
    } else {
        s.putBits(0, 1);                 // frame_cropping_flag
    }
    s.putBits(0, 1);                     // vui_parameters_present_flag
    s.rbspTrailing();
    spsAnnexB.clear();
    appendNal(spsAnnexB, 7, 3, s.out);
    // ---- PPS ----
    BitWriter p;
    p.putUe(0);                          // pic_parameter_set_id
    p.putUe(0);                          // seq_parameter_set_id
    p.putBits(baseline ? 0 : 1, 1);      // entropy_coding_mode_flag (CAVLC baseline)
    p.putBits(0, 1);                     // bottom_field_pic_order_in_frame_present_flag
    p.putUe(0);                          // num_slice_groups_minus1
    p.putUe(0);                          // num_ref_idx_l0_default_active_minus1
    p.putUe(0);                          // num_ref_idx_l1_default_active_minus1
    p.putBits(0, 1);                     // weighted_pred_flag
    p.putBits(0, 2);                     // weighted_bipred_idc
    p.putSe(0); p.putSe(0); p.putSe(0);  // qp offsets
    p.putBits(1, 1);                     // deblocking_filter_control_present_flag
    p.putBits(0, 1);                     // constrained_intra_pred_flag
    p.putBits(0, 1);                     // redundant_pic_cnt_present_flag
    p.putBits((profileIdc == 100) ? 1 : 0, 1); // transform_8x8_mode_flag
    p.putBits(0, 1);                     // pic_scaling_matrix_present_flag
    p.putSe(0);                          // second_chroma_qp_index_offset
    p.rbspTrailing();
    ppsAnnexB.clear();
    appendNal(ppsAnnexB, 8, 3, p.out);
    (void)err;
    return true;
}

void destroySession(EncSession *s) {
    if (!s) return;
    for (size_t i = 0; i < s->frameBufs.size(); ++i) {
        if (s->dpy) vaDestroyBuffer(s->dpy, s->frameBufs[i]);
    }
    s->frameBufs.clear();
    const VABufferID persist[] = { s->bSeq, s->bPic, s->bSlice, s->bRc, s->bHrd, s->bFr,
                                   s->bPackSeqP, s->bPackSeqD, s->bPackPicP, s->bPackPicD,
                                   s->bPackSliceP, s->bPackSliceD };
    for (VABufferID b : persist) {
        if (b != VA_INVALID_ID && s->dpy) vaDestroyBuffer(s->dpy, b);
    }
    if (s->uploadImgValid) { vaDestroyImage(s->dpy, s->uploadImg.image_id); s->uploadImgValid = false; }
    if (s->codedBuf != VA_INVALID_ID) { vaDestroyBuffer(s->dpy, s->codedBuf); s->codedBuf = VA_INVALID_ID; }
    if (s->ctx != VA_INVALID_ID) { vaDestroyContext(s->dpy, s->ctx); s->ctx = VA_INVALID_ID; }
    if (s->config != VA_INVALID_ID) { vaDestroyConfig(s->dpy, s->config); s->config = VA_INVALID_ID; }
    for (int i = 0; i < kNumSurfaces; ++i) {
        if (s->surfaces[i] != VA_INVALID_SURFACE) { vaDestroySurfaces(s->dpy, &s->surfaces[i], 1); s->surfaces[i] = VA_INVALID_SURFACE; }
        if (s->recon[i] != VA_INVALID_SURFACE) { vaDestroySurfaces(s->dpy, &s->recon[i], 1); s->recon[i] = VA_INVALID_SURFACE; }
    }
    if (s->dpy) { vaTerminate(s->dpy); s->dpy = nullptr; }
    if (s->drmFd >= 0) { close(s->drmFd); s->drmFd = -1; }
    delete s;
}

static std::map<int, EncSession*> g_sessions;
static int g_nextHandle = 1;

bool fail(Napi::Env env, const std::string &msg) {
    Napi::Error::New(env, msg).ThrowAsJavaScriptException();
    return false;
}

// BT.601 full-range RGBA -> NV12.
void rgbaToNv12(const uint8_t *rgba, uint8_t *yv12y, uint8_t *uv, int w, int h) {
    for (int y = 0; y < h; y += 2) {
        for (int x = 0; x < w; x += 2) {
            int u = 0, v = 0;
            for (int dy = 0; dy < 2; ++dy) {
                for (int dx = 0; dx < 2; ++dx) {
                    const uint8_t *p = rgba + ((y + dy) * w + (x + dx)) * 4;
                    int r = p[0], g = p[1], b = p[2];
                    int yy = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
                    yv12y[(y + dy) * w + (x + dx)] = (uint8_t)(yy < 0 ? 0 : (yy > 255 ? 255 : yy));
                    u += ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
                    v += ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
                }
            }
            int o = (y / 2) * w + x;
            int uu = u / 4, vv = v / 4;
            uv[o] = (uint8_t)(uu < 0 ? 0 : (uu > 255 ? 255 : uu));
            uv[o + 1] = (uint8_t)(vv < 0 ? 0 : (vv > 255 ? 255 : vv));
        }
    }
}

Napi::Value Info(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    Napi::Object out = Napi::Object::New(env);
    int fd = open("/dev/dri/renderD128", O_RDWR);
    if (fd < 0) { out.Set("ok", false); out.Set("error", "no render node"); return out; }
    VADisplay dpy = vaGetDisplayDRM(fd);
    if (!dpy) { close(fd); out.Set("ok", false); out.Set("error", "vaGetDisplayDRM failed"); return out; }
    int major = 0, minor = 0;
    VAStatus st = vaInitialize(dpy, &major, &minor);
    if (st != VA_STATUS_SUCCESS) { vaTerminate(dpy); close(fd); out.Set("ok", false); out.Set("error", std::string("vaInitialize: ") + vaErrorStr(st)); return out; }
    const char *drv = vaQueryVendorString(dpy);
    int nProfiles = vaMaxNumProfiles(dpy);
    std::vector<VAProfile> profiles(nProfiles);
    int got = 0;
    if (vaQueryConfigProfiles(dpy, profiles.data(), &got) == VA_STATUS_SUCCESS) profiles.resize(got);
    else profiles.clear();
    Napi::Array arr = Napi::Array::New(env, profiles.size());
    for (size_t i = 0; i < profiles.size(); ++i) arr[i] = (int)profiles[i];
    // H264 encode support?
    bool h264enc = false;
    {
        int nEp = vaMaxNumEntrypoints(dpy);
        std::vector<VAEntrypoint> eps(nEp);
        int nGot = 0;
        if (vaQueryConfigEntrypoints(dpy, VAProfileH264High, eps.data(), &nGot) == VA_STATUS_SUCCESS) {
            for (int i = 0; i < nGot; ++i) if (eps[i] == VAEntrypointEncSlice) h264enc = true;
        }
    }
    out.Set("ok", true);
    out.Set("driver", drv ? drv : "?");
    out.Set("profiles", arr);
    out.Set("h264enc", h264enc);
    vaTerminate(dpy);
    close(fd);
    return out;
}

bool optInt(Napi::Object o, const char *k, int &dst) {
    if (!o.Has(k)) return true;
    Napi::Value v = o.Get(k);
    if (!v.IsNumber()) return false;
    dst = (int)v.As<Napi::Number>().Int32Value();
    return true;
}

Napi::Value Init(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) { fail(env, "init(opts) required"); return env.Null(); }
    Napi::Object o = info[0].As<Napi::Object>();
    int width = 0, height = 0, bitrate = 4000000, fps = 30;
    if (!optInt(o, "width", width) || !optInt(o, "height", height) ||
        !optInt(o, "bitrate", bitrate) || !optInt(o, "fps", fps)) {
        fail(env, "width/height/bitrate/fps must be numbers"); return env.Null();
    }
    std::string device = "/dev/dri/renderD128";
    if (o.Has("device")) {
        Napi::Value v = o.Get("device");
        if (!v.IsString()) { fail(env, "device must be a string"); return env.Null(); }
        device = v.As<Napi::String>().Utf8Value();
    }
    if (width < 16 || height < 16 || (width % 2) || (height % 2)) { fail(env, "width/height must be even and >= 16"); return env.Null(); }
    if (fps < 1 || fps > 240) fps = 30;

    EncSession *s = new EncSession();
    s->width = width; s->height = height;
    // Pad encode geometry up to whole macroblocks (ffmpeg model): the driver
    // and SPS must agree on dimensions, or DPB accounting goes sideways.
    s->encW = (width + 15) / 16 * 16; s->encH = (height + 15) / 16 * 16;
    s->cropRight = (s->encW - width) / 2; s->cropBottom = (s->encH - height) / 2;
    s->mbW = s->encW / 16; s->mbH = s->encH / 16;
    s->bitrate = bitrate; s->fps = fps; s->idrPeriod = fps * 2;
    int gopOpt = 0;
    if (!optInt(o, "gop", gopOpt)) gopOpt = 0;
    // gop<=1 (or fps*2 default): all-intra when gop==1. All-intra avoids the
    // DPB/reference machinery entirely (instant join, error resilience) at
    // the cost of bitrate efficiency.
    if (gopOpt > 0) s->idrPeriod = gopOpt;
    s->nv12scratch.resize((size_t)width * height * 3 / 2);

    s->drmFd = open(device.c_str(), O_RDWR);
    if (s->drmFd < 0) { delete s; fail(env, "open render node failed: " + device); return env.Null(); }
    s->dpy = vaGetDisplayDRM(s->drmFd);
    if (!s->dpy) { destroySession(s); fail(env, "vaGetDisplayDRM failed"); return env.Null(); }
    int major = 0, minor = 0;
    VAStatus st = vaInitialize(s->dpy, &major, &minor);
    if (st != VA_STATUS_SUCCESS) { destroySession(s); fail(env, std::string("vaInitialize: ") + vaErrorStr(st)); return env.Null(); }

    // Profile chain: High -> Main -> ConstrainedBaseline.
    const VAProfile tryProfiles[] = { VAProfileH264High, VAProfileH264Main, VAProfileH264ConstrainedBaseline };
    bool haveProfile = false;
    for (VAProfile p : tryProfiles) {
        int nEp = vaMaxNumEntrypoints(s->dpy);
        std::vector<VAEntrypoint> eps(nEp);
        int nGot = 0;
        if (vaQueryConfigEntrypoints(s->dpy, p, eps.data(), &nGot) != VA_STATUS_SUCCESS) continue;
        for (int i = 0; i < nGot; ++i) {
            if (eps[i] == VAEntrypointEncSlice) { s->profile = p; haveProfile = true; break; }
        }
        if (haveProfile) break;
    }
    if (!haveProfile) { destroySession(s); fail(env, "no H264 EncSlice profile"); return env.Null(); }

    VAConfigAttrib attrib[3];
    attrib[0].type = VAConfigAttribRTFormat; attrib[0].value = VA_RT_FORMAT_YUV420;
    attrib[1].type = VAConfigAttribRateControl; attrib[1].value = VA_RC_CBR;
    int nAttrib = 2;
    unsigned packedMask = 0;
    if (!getenv("VAAPI_NO_PACKED")) {
    {
        // Packed SPS/PPS headers (ffmpeg model): the driver copies our header
        // NALs into the stream. Its unpacked-header path is flaky on navi33.
        VAConfigAttrib pq;
        pq.type = VAConfigAttribEncPackedHeaders;
        if (vaGetConfigAttributes(s->dpy, s->profile, VAEntrypointEncSlice, &pq, 1) == VA_STATUS_SUCCESS) {
            unsigned want = VA_ENC_PACKED_HEADER_SEQUENCE | VA_ENC_PACKED_HEADER_PICTURE | VA_ENC_PACKED_HEADER_SLICE;
            if (pq.value & want) {
                packedMask = pq.value & want;
                attrib[2].type = VAConfigAttribEncPackedHeaders;
                attrib[2].value = (int)packedMask;
                nAttrib = 3;
            }
        }
    }
    }
    s->packedMask = packedMask;
    st = vaCreateConfig(s->dpy, s->profile, VAEntrypointEncSlice, attrib, nAttrib, &s->config);
    if (st != VA_STATUS_SUCCESS) { destroySession(s); fail(env, std::string("vaCreateConfig: ") + vaErrorStr(st)); return env.Null(); }

    st = vaCreateSurfaces(s->dpy, VA_RT_FORMAT_YUV420, s->encW, s->encH, s->surfaces, kNumSurfaces, nullptr, 0);
    if (st != VA_STATUS_SUCCESS) { destroySession(s); fail(env, std::string("vaCreateSurfaces(input): ") + vaErrorStr(st)); return env.Null(); }
    // Dedicated recon scratch pool (separate from inputs).
    st = vaCreateSurfaces(s->dpy, VA_RT_FORMAT_YUV420, s->encW, s->encH, s->recon, kNumSurfaces, nullptr, 0);
    if (st != VA_STATUS_SUCCESS) { destroySession(s); fail(env, std::string("vaCreateSurfaces(recon): ") + vaErrorStr(st)); return env.Null(); }
    // NOTE: input surfaces double as the context pool (Intel-sample model).
    st = vaCreateContext(s->dpy, s->config, s->encW, s->encH, VA_PROGRESSIVE, s->surfaces, kNumSurfaces, &s->ctx);
    if (st != VA_STATUS_SUCCESS) { destroySession(s); fail(env, std::string("vaCreateContext: ") + vaErrorStr(st)); return env.Null(); }

    // Oversized on purpose: if an IDR spikes past the buffer, some drivers
    // overrun rather than flagging overflow (random downstream crashes).
    unsigned codedSize = (unsigned)((size_t)s->encW * s->encH * 3 + 1048576);
    st = vaCreateBuffer(s->dpy, s->ctx, VAEncCodedBufferType, codedSize, 1, nullptr, &s->codedBuf);
    if (st != VA_STATUS_SUCCESS) { destroySession(s); fail(env, std::string("vaCreateBuffer(coded): ") + vaErrorStr(st)); return env.Null(); }

    // Persistent NV12 upload image (fully zeroed: garbage in depth/masks/
    // reserved causes flaky driver failures).
    VAImageFormat fmt;
    memset(&fmt, 0, sizeof(fmt));
    fmt.fourcc = VA_FOURCC_NV12; fmt.byte_order = VA_LSB_FIRST; fmt.bits_per_pixel = 12;
    st = vaCreateImage(s->dpy, &fmt, s->encW, s->encH, &s->uploadImg);
    if (st != VA_STATUS_SUCCESS) { destroySession(s); fail(env, std::string("vaCreateImage(NV12): ") + vaErrorStr(st)); return env.Null(); }
    s->uploadImgValid = true;
    if (getenv("VAAPI_DEBUG")) {
        fprintf(stderr, "[vaapi-enc] img %ux%u pitches=[%u,%u,%u] offsets=[%u,%u,%u] planes=%d size=%u\n",
                s->uploadImg.width, s->uploadImg.height,
                s->uploadImg.pitches[0], s->uploadImg.pitches[1], s->uploadImg.pitches[2],
                s->uploadImg.offsets[0], s->uploadImg.offsets[1], s->uploadImg.offsets[2],
                s->uploadImg.num_planes, s->uploadImg.data_size);
        fflush(stderr);
    }

    std::string herr;
    if (!s->buildHeaders(herr)) { destroySession(s); fail(env, "header build failed"); return env.Null(); }

    // Persistent parameter buffers (created once, updated in place).
    auto mkPersist = [&](VABufferType type, unsigned size, VABufferID &slot, const char *what) -> bool {
        VAStatus mst = vaCreateBuffer(s->dpy, s->ctx, type, size, 1, nullptr, &slot);
        if (mst != VA_STATUS_SUCCESS) { fail(env, std::string("persist ") + what + ": " + vaErrorStr(mst)); return false; }
        return true;
    };
    const unsigned miscRcSize = (unsigned)(sizeof(VAEncMiscParameterBuffer) + sizeof(VAEncMiscParameterRateControl));
    const unsigned miscHrdSize = (unsigned)(sizeof(VAEncMiscParameterBuffer) + sizeof(VAEncMiscParameterHRD));
    const unsigned miscFrSize = (unsigned)(sizeof(VAEncMiscParameterBuffer) + sizeof(VAEncMiscParameterFrameRate));
    if (!mkPersist(VAEncSequenceParameterBufferType, (unsigned)sizeof(VAEncSequenceParameterBufferH264), s->bSeq, "seq") ||
        !mkPersist(VAEncPictureParameterBufferType, (unsigned)sizeof(VAEncPictureParameterBufferH264), s->bPic, "pic") ||
        !mkPersist(VAEncSliceParameterBufferType, (unsigned)sizeof(VAEncSliceParameterBufferH264), s->bSlice, "slice") ||
        !mkPersist(VAEncMiscParameterBufferType, miscRcSize, s->bRc, "rc") ||
        !mkPersist(VAEncMiscParameterBufferType, miscHrdSize, s->bHrd, "hrd") ||
        !mkPersist(VAEncMiscParameterBufferType, miscFrSize, s->bFr, "fr") ||
        !mkPersist(VAEncPackedHeaderParameterBufferType, (unsigned)sizeof(VAEncPackedHeaderParameterBuffer), s->bPackSeqP, "packseqp") ||
        !mkPersist(VAEncPackedHeaderDataBufferType, (unsigned)s->spsAnnexB.size(), s->bPackSeqD, "packseqd") ||
        !mkPersist(VAEncPackedHeaderParameterBufferType, (unsigned)sizeof(VAEncPackedHeaderParameterBuffer), s->bPackPicP, "packpicp") ||
        !mkPersist(VAEncPackedHeaderDataBufferType, (unsigned)s->ppsAnnexB.size(), s->bPackPicD, "packpicd") ||
        !mkPersist(VAEncPackedHeaderParameterBufferType, (unsigned)sizeof(VAEncPackedHeaderParameterBuffer), s->bPackSliceP, "packslicep") ||
        !mkPersist(VAEncPackedHeaderDataBufferType, 64, s->bPackSliceD, "packsliced")) {
        destroySession(s);
        return env.Null();
    }

    int handle = g_nextHandle++;
    g_sessions[handle] = s;
    return Napi::Number::New(env, handle);
}
static void retireFrameBufs(EncSession *s) {
    for (size_t i = 0; i < s->frameBufs.size(); ++i) vaDestroyBuffer(s->dpy, s->frameBufs[i]);
    s->frameBufs.clear();
}

// Persistent-buffer update: map, copy new params, unmap, render. Buffers
// live for the whole session (ffmpeg model); no per-frame create/destroy.
static VAStatus updateRender(EncSession *s, VABufferID buf, const void *data, unsigned size) {
    void *p = nullptr;
    VAStatus st = vaMapBuffer(s->dpy, buf, &p);
    if (st != VA_STATUS_SUCCESS) return st;
    memcpy(p, data, size);
    vaUnmapBuffer(s->dpy, buf);
    VABufferID bufs[1] = { buf };
    return vaRenderPicture(s->dpy, s->ctx, bufs, 1);
}

// Recycles the VA context + coded buffer mid-stream (forces IDR next).
// navi33/radeonsi accumulates broken internal state over long sessions;
// a periodic reset keeps sustained encodes alive.
static bool recycleContext(EncSession *s, std::string &err) {
    retireFrameBufs(s);
    if (s->codedBuf != VA_INVALID_ID) { vaDestroyBuffer(s->dpy, s->codedBuf); s->codedBuf = VA_INVALID_ID; }
    if (s->ctx != VA_INVALID_ID) { vaDestroyContext(s->dpy, s->ctx); s->ctx = VA_INVALID_ID; }
    VAStatus st = vaCreateContext(s->dpy, s->config, s->width, s->height, VA_PROGRESSIVE,
                                  s->surfaces, kNumSurfaces, &s->ctx);
    if (st != VA_STATUS_SUCCESS) { err = std::string("recycle vaCreateContext: ") + vaErrorStr(st); return false; }
    unsigned codedSize = (unsigned)((size_t)s->width * s->height * 3 / 2 + 131072);
    st = vaCreateBuffer(s->dpy, s->ctx, VAEncCodedBufferType, codedSize, 1, nullptr, &s->codedBuf);
    if (st != VA_STATUS_SUCCESS) { err = std::string("recycle vaCreateBuffer: ") + vaErrorStr(st); return false; }
    s->refSurf = VA_INVALID_SURFACE;
    return true;
}

Napi::Value Encode(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsBuffer() || !info[2].IsBoolean()) {
        fail(env, "encode(handle, rgbaBuffer, keyFrame) required"); return env.Null();
    }
    int handle = (int)info[0].As<Napi::Number>().Int32Value();
    auto it = g_sessions.find(handle);
    if (it == g_sessions.end()) { fail(env, "bad handle"); return env.Null(); }
    EncSession *s = it->second;
    retireFrameBufs(s); // drain any leftovers from a previously failed frame
    Napi::Buffer<uint8_t> in = info[1].As<Napi::Buffer<uint8_t>>();
    bool wantKey = info[2].As<Napi::Boolean>().Value();
    size_t expect = (size_t)s->width * s->height * 4;
    if (in.Length() < expect) { fail(env, "rgba buffer too small"); return env.Null(); }

    const int w = s->width, h = s->height;
    uint8_t *nv = s->nv12scratch.data();
    rgbaToNv12(in.Data(), nv, nv + (size_t)w * h, w, h);

    VASurfaceID surf = s->surfaces[s->nextSurf % kNumSurfaces];
    s->nextSurf++;
    // Make sure the surface is fully idle BEFORE uploading: the driver may
    // still reference it internally (DPB/scratch) after our last sync, and
    // overwriting a busy surface corrupts in-flight state (random hangs).
    vaSyncSurface(s->dpy, surf);
    if (getenv("VAAPI_DEBUG")) { fprintf(stderr, "[vaapi-enc] surf=%u img=%u buf=%u ctx=%u\n", (unsigned)surf, (unsigned)s->uploadImg.image_id, (unsigned)s->uploadImg.buf, (unsigned)s->ctx); fflush(stderr); }

    void *imgMem = nullptr;
    VAStatus st = vaMapBuffer(s->dpy, s->uploadImg.buf, &imgMem);
    if (st != VA_STATUS_SUCCESS) { fail(env, std::string("vaMapBuffer(upload): ") + vaErrorStr(st)); return env.Null(); }
    // Copy Y then interleaved UV respecting image pitches.
    uint8_t *dst = (uint8_t *)imgMem + s->uploadImg.offsets[0];
    for (int y = 0; y < h; ++y) { memcpy(dst + (size_t)y * s->uploadImg.pitches[0], nv + (size_t)y * w, (size_t)w); }
    uint8_t *uvSrc = nv + (size_t)w * h;
    uint8_t *dstUV = (uint8_t *)imgMem + s->uploadImg.offsets[1];
    for (int y = 0; y < h / 2; ++y) { memcpy(dstUV + (size_t)y * s->uploadImg.pitches[1], uvSrc + (size_t)y * w, (size_t)w); }
    vaUnmapBuffer(s->dpy, s->uploadImg.buf);
    VARectangle srcRect = { 0, 0, (unsigned)w, (unsigned)h };
    VARectangle dstRect = { 0, 0, (unsigned)w, (unsigned)h };
    st = vaPutImage(s->dpy, surf, s->uploadImg.image_id, 0, 0, w, h, 0, 0, w, h);
    (void)srcRect; (void)dstRect;
    if (st != VA_STATUS_SUCCESS) { fail(env, std::string("vaPutImage: ") + vaErrorStr(st)); return env.Null(); }
    vdbg("upload-ok");

    bool isIdr = wantKey || (s->frameCount % s->idrPeriod == 0);
    // Periodic context recycle (every 120 frames): navi33 accumulates broken
    // internal encoder state over sustained sessions; a fresh context + IDR
    // keeps long streams alive. Cheap (~1ms) and invisible downstream.
    if (!isIdr && s->frameCount > 0 && (s->frameCount % 120) == 0) {
        std::string rerr;
        if (!recycleContext(s, rerr)) { fail(env, rerr); return env.Null(); }
        isIdr = true;
        vdbg("recycled-ctx");
    }
    int fn = s->frameCount % 16;
    int poc = (s->frameCount * 2) % 32;

    st = vaBeginPicture(s->dpy, s->ctx, surf);
    if (st != VA_STATUS_SUCCESS) { fail(env, std::string("vaBeginPicture: ") + vaErrorStr(st)); return env.Null(); }

    // Sequence + rate-control state. Sent on IDR frames only (like ffmpeg):
    // the driver persists it, and the HRD/framerate state is what keeps CBR
    // stable across complex content.
    if (isIdr) {
    // Sequence params.
    VAEncSequenceParameterBufferH264 seq;
    memset(&seq, 0, sizeof(seq));
    seq.seq_parameter_set_id = 0;
    seq.level_idc = 42;
    seq.intra_period = (uint32_t)s->idrPeriod;
    seq.intra_idr_period = (uint32_t)s->idrPeriod;
    seq.ip_period = 1;
    seq.bits_per_second = (uint32_t)s->bitrate;
    // Single-entry DPB: the app declares exactly one backward reference, so
    // tell the driver the DPB holds one frame. A larger value lets the driver
    // retain older round-robin surfaces as phantom DPB slots that later get
    // overwritten by uploads -> random userspace crashes.
    seq.max_num_ref_frames = 1;
    seq.picture_width_in_mbs = (uint16_t)s->mbW;
    seq.picture_height_in_mbs = (uint16_t)s->mbH;
    seq.seq_fields.bits.chroma_format_idc = 1;
    seq.seq_fields.bits.frame_mbs_only_flag = 1;
    seq.seq_fields.bits.mb_adaptive_frame_field_flag = 0;
    seq.seq_fields.bits.seq_scaling_matrix_present_flag = 0;
    seq.seq_fields.bits.direct_8x8_inference_flag = 1;
    seq.seq_fields.bits.log2_max_frame_num_minus4 = 0;
    seq.seq_fields.bits.pic_order_cnt_type = 0;
    seq.seq_fields.bits.log2_max_pic_order_cnt_lsb_minus4 = 1;
    seq.seq_fields.bits.delta_pic_order_always_zero_flag = 0;
    seq.bit_depth_luma_minus8 = 0;
    seq.bit_depth_chroma_minus8 = 0;
    seq.frame_cropping_flag = 0;
    seq.vui_parameters_present_flag = 0;
    st = updateRender(s, s->bSeq, &seq, sizeof(seq));
    if (st != VA_STATUS_SUCCESS) { vaEndPicture(s->dpy, s->ctx); fail(env, std::string("seq param: ") + vaErrorStr(st)); return env.Null(); }
    } // end if (isIdr): sequence state only

    // Picture params.
    VAEncPictureParameterBufferH264 pic;
    memset(&pic, 0, sizeof(pic));
    // CurrPic = dedicated recon scratch (NOT the input surface): with input
    // aliasing, uploads can clobber the driver's in-flight reference state.
    // (radeonsi also rejects this combo at slice validation when RefPicList
    //  is empty, so the explicit L0 list below is still required.)
    VASurfaceID reconSurf = s->recon[s->nextRecon % kNumSurfaces];
    s->nextRecon++;
    pic.CurrPic.picture_id = reconSurf;
    pic.CurrPic.frame_idx = (uint32_t)fn;
    // NB: leave CurrPic.flags = 0 (like ffmpeg). Setting SHORT_TERM_REFERENCE
    // here makes radeonsi reject P frames: the current picture is not (yet)
    // in ReferenceFrames, so the driver flags it invalid. Ref-ness travels in
    // pic_fields.reference_pic_flag instead.
    pic.CurrPic.flags = 0;
    pic.CurrPic.TopFieldOrderCnt = poc;
    pic.CurrPic.BottomFieldOrderCnt = poc;
    for (int i = 0; i < 16; ++i) pic.ReferenceFrames[i].picture_id = VA_INVALID_SURFACE;
    if (!isIdr && s->refSurf != VA_INVALID_SURFACE) {
        // refSurf tracks the previous RECON surface in this model.
        pic.ReferenceFrames[0].picture_id = s->refSurf;
        pic.ReferenceFrames[0].frame_idx = (uint32_t)s->refFrameNum;
        pic.ReferenceFrames[0].flags = VA_PICTURE_H264_SHORT_TERM_REFERENCE;
        pic.ReferenceFrames[0].TopFieldOrderCnt = s->refPoc;
        pic.ReferenceFrames[0].BottomFieldOrderCnt = s->refPoc;
    }
    pic.coded_buf = s->codedBuf;
    pic.pic_parameter_set_id = 0;
    pic.seq_parameter_set_id = 0;
    pic.last_picture = 0;
    pic.frame_num = (uint16_t)fn;
    pic.pic_init_qp = 26;
    pic.num_ref_idx_l0_active_minus1 = 0;
    pic.num_ref_idx_l1_active_minus1 = 0;
    pic.chroma_qp_index_offset = 0;
    pic.second_chroma_qp_index_offset = 0;
    pic.pic_fields.bits.idr_pic_flag = isIdr ? 1 : 0;
    pic.pic_fields.bits.reference_pic_flag = 1;
    pic.pic_fields.bits.entropy_coding_mode_flag = (s->profile == VAProfileH264ConstrainedBaseline) ? 0 : 1;
    pic.pic_fields.bits.weighted_pred_flag = 0;
    pic.pic_fields.bits.weighted_bipred_idc = 0;
    pic.pic_fields.bits.constrained_intra_pred_flag = 0;
    pic.pic_fields.bits.transform_8x8_mode_flag = (s->profile == VAProfileH264High) ? 1 : 0;
    pic.pic_fields.bits.deblocking_filter_control_present_flag = 1;
    pic.pic_fields.bits.redundant_pic_cnt_present_flag = 0;
    pic.pic_fields.bits.pic_order_present_flag = 0;
    pic.pic_fields.bits.pic_scaling_matrix_present_flag = 0;
    st = updateRender(s, s->bPic, &pic, sizeof(pic));
    if (st != VA_STATUS_SUCCESS) { vaEndPicture(s->dpy, s->ctx); fail(env, std::string("pic param: ") + vaErrorStr(st)); return env.Null(); }

    // Rate control + HRD + framerate state (ffmpeg parity). Sent on IDR
    // frames only into persistent buffers (no per-frame create/destroy).
    if (isIdr) {
    // Rate control (CBR).
    {
        unsigned char mrc[sizeof(VAEncMiscParameterBuffer) + sizeof(VAEncMiscParameterRateControl)];
        memset(mrc, 0, sizeof(mrc));
        ((VAEncMiscParameterBuffer *)mrc)->type = VAEncMiscParameterTypeRateControl;
        VAEncMiscParameterRateControl *rc = (VAEncMiscParameterRateControl *)(((VAEncMiscParameterBuffer *)mrc)->data);
        rc->bits_per_second = (uint32_t)s->bitrate;
        rc->target_percentage = 50;
        rc->window_size = 500;
        rc->initial_qp = 26;
        rc->min_qp = 0;
        rc->basic_unit_size = 0;
        st = updateRender(s, s->bRc, mrc, sizeof(mrc));
        if (st != VA_STATUS_SUCCESS) { vaEndPicture(s->dpy, s->ctx); fail(env, std::string("rc param: ") + vaErrorStr(st)); return env.Null(); }
    }
    } // end if (isIdr): rate control state
    // HRD + framerate state (ffmpeg parity: HRD CPB = 1x bitrate, init 3/4).
    if (isIdr) {
        VAEncMiscParameterHRD hrd;
        memset(&hrd, 0, sizeof(hrd));
        hrd.initial_buffer_fullness = (uint32_t)(s->bitrate * 3 / 4);
        hrd.buffer_size = (uint32_t)s->bitrate;
        unsigned char mh[sizeof(VAEncMiscParameterBuffer) + sizeof(hrd)];
        memset(mh, 0, sizeof(mh));
        ((VAEncMiscParameterBuffer *)mh)->type = VAEncMiscParameterTypeHRD;
        memcpy(mh + sizeof(VAEncMiscParameterBuffer), &hrd, sizeof(hrd));
        st = updateRender(s, s->bHrd, mh, sizeof(mh));
        if (st != VA_STATUS_SUCCESS) { vaEndPicture(s->dpy, s->ctx); fail(env, std::string("hrd param: ") + vaErrorStr(st)); return env.Null(); }
        VAEncMiscParameterFrameRate fr;
        memset(&fr, 0, sizeof(fr));
        fr.framerate = (uint32_t)(((1 << 16) | (s->fps & 0xffff)) & 0xffffffff);
        unsigned char mf[sizeof(VAEncMiscParameterBuffer) + sizeof(fr)];
        memset(mf, 0, sizeof(mf));
        ((VAEncMiscParameterBuffer *)mf)->type = VAEncMiscParameterTypeFrameRate;
        memcpy(mf + sizeof(VAEncMiscParameterBuffer), &fr, sizeof(fr));
        st = updateRender(s, s->bFr, mf, sizeof(mf));
        if (st != VA_STATUS_SUCCESS) { vaEndPicture(s->dpy, s->ctx); fail(env, std::string("framerate param: ") + vaErrorStr(st)); return env.Null(); }
    }

    // Packed SPS/PPS (ffmpeg model): hand the driver our header NALs so it
    // copies them into the stream, instead of relying on its unpacked path.
    // Param + data MUST ride in a single vaRenderPicture call, or the driver
    // cannot associate them and silently drops both (garbage output).
    // Persistent buffers, refreshed on IDR.
    //
    // Packed SLICE headers too: on navi33 the driver's own slice-header
    // generation emits corrupt NALs (first byte zeroed), so we supply the
    // header RBSP and the driver appends slice data after it.
    if (isIdr && s->packedMask) {
        auto renderPacked = [&](unsigned htype, VABufferID paramBuf, VABufferID dataBuf,
                                const std::vector<uint8_t> &nal, const char *what) -> bool {
            VAEncPackedHeaderParameterBuffer pp;
            memset(&pp, 0, sizeof(pp));
            pp.type = htype;
            pp.bit_length = (uint32_t)(nal.size() * 8);
            pp.has_emulation_bytes = 1;
            void *p = nullptr;
            if (vaMapBuffer(s->dpy, paramBuf, &p) != VA_STATUS_SUCCESS) return false;
            memcpy(p, &pp, sizeof(pp));
            vaUnmapBuffer(s->dpy, paramBuf);
            if (vaMapBuffer(s->dpy, dataBuf, &p) != VA_STATUS_SUCCESS) return false;
            memcpy(p, nal.data(), nal.size());
            vaUnmapBuffer(s->dpy, dataBuf);
            VABufferID bufs[2] = { paramBuf, dataBuf };
            VAStatus mst = vaRenderPicture(s->dpy, s->ctx, bufs, 2);
            if (mst != VA_STATUS_SUCCESS) {
                vaEndPicture(s->dpy, s->ctx);
                fail(env, std::string(what) + ": " + vaErrorStr(mst));
                return false;
            }
            return true;
        };
        if ((s->packedMask & VA_ENC_PACKED_HEADER_SEQUENCE) &&
            !renderPacked(VAEncPackedHeaderSequence, s->bPackSeqP, s->bPackSeqD, s->spsAnnexB, "packed sps")) return env.Null();
        if ((s->packedMask & VA_ENC_PACKED_HEADER_PICTURE) &&
            !renderPacked(VAEncPackedHeaderPicture, s->bPackPicP, s->bPackPicD, s->ppsAnnexB, "packed pps")) return env.Null();
    }

    // Packed slice header, built per frame (after fn/poc known). The driver
    // appends slice data after it; together they form the slice NAL.
    std::vector<uint8_t> sliceHdrAnnexB;
    bool havePackedSlice = false;
    if (s->packedMask & VA_ENC_PACKED_HEADER_SLICE) {
        BitWriter sh;
        sh.putUe(0);                                   // first_mb_in_slice
        sh.putUe(isIdr ? 2 : 0);                       // slice_type (I / P)
        sh.putUe(0);                                   // pic_parameter_set_id
        sh.putBits((uint32_t)fn, 4);                   // frame_num (log2=0 -> 4b)
        if (isIdr) sh.putUe((uint32_t)(s->idrCount & 0xffff)); // idr_pic_id
        sh.putBits((uint32_t)poc, 5);                  // pic_order_cnt_lsb (log2=1 -> 5b)
        if (!isIdr) {
            sh.putBits(0, 1);                          // num_ref_idx_override = 0
            sh.putBits(0, 1);                          // ref_pic_list_modification_flag_l0 = 0
            // weighted_pred_flag = 0 -> no pred_weight_table
            sh.putBits(0, 1);                          // adaptive_ref_pic_marking_mode = 0 (sliding window)
        }
        sh.rbspTrailing();
        sliceHdrAnnexB.clear();
        appendNal(sliceHdrAnnexB, isIdr ? 5 : 1, isIdr ? 3 : 2, sh.out);
        havePackedSlice = true;
    }

    // Render the packed slice header (param+data together) right before the
    // slice params, every frame.
    if (havePackedSlice && (s->packedMask & VA_ENC_PACKED_HEADER_SLICE)) {
        if (sliceHdrAnnexB.size() > 64) { fail(env, "slice header overflow"); return env.Null(); }
        VAEncPackedHeaderParameterBuffer spp;
        memset(&spp, 0, sizeof(spp));
        spp.type = VA_ENC_PACKED_HEADER_SLICE;
        spp.bit_length = (uint32_t)(sliceHdrAnnexB.size() * 8);
        spp.has_emulation_bytes = 1;
        void *pp = nullptr;
        if (vaMapBuffer(s->dpy, s->bPackSliceP, &pp) != VA_STATUS_SUCCESS) { fail(env, "packslice map"); return env.Null(); }
        memcpy(pp, &spp, sizeof(spp));
        vaUnmapBuffer(s->dpy, s->bPackSliceP);
        if (vaMapBuffer(s->dpy, s->bPackSliceD, &pp) != VA_STATUS_SUCCESS) { fail(env, "packsliced map"); return env.Null(); }
        memcpy(pp, sliceHdrAnnexB.data(), sliceHdrAnnexB.size());
        vaUnmapBuffer(s->dpy, s->bPackSliceD);
        VABufferID pbufs[2] = { s->bPackSliceP, s->bPackSliceD };
        st = vaRenderPicture(s->dpy, s->ctx, pbufs, 2);
        if (st != VA_STATUS_SUCCESS) { vaEndPicture(s->dpy, s->ctx); fail(env, std::string("packed slice: ") + vaErrorStr(st)); return env.Null(); }
    }

    // Single slice for the whole frame.
    VAEncSliceParameterBufferH264 slice;
    memset(&slice, 0, sizeof(slice));
    slice.macroblock_address = 0;
    slice.num_macroblocks = (uint32_t)(s->mbW * s->mbH);
    slice.macroblock_info = VA_INVALID_ID;
    slice.slice_type = isIdr ? 2 : 0;
    slice.pic_parameter_set_id = 0;
    // idr_pic_id is only meaningful on IDR slices; non-zero values on P
    // slices are rejected as invalid parameter by strict drivers.
    slice.idr_pic_id = isIdr ? (uint16_t)(s->idrCount & 0xffff) : 0;
    slice.pic_order_cnt_lsb = (uint16_t)poc;
    if (!isIdr && s->refSurf != VA_INVALID_SURFACE) {
        // Explicit L0 reference list. The driver validates RefPicList0[0]
        // against real surfaces — leaving it zeroed (surface 0) fails P
        // frames with "invalid parameter" even though pic params carry refs.
        // Keep override OFF (pic-level num_ref wins, like ffmpeg).
        slice.num_ref_idx_active_override_flag = 0;
        slice.num_ref_idx_l0_active_minus1 = 0;
        slice.RefPicList0[0].picture_id = s->refSurf;
        slice.RefPicList0[0].frame_idx = (uint32_t)s->refFrameNum;
        slice.RefPicList0[0].flags = VA_PICTURE_H264_SHORT_TERM_REFERENCE;
        slice.RefPicList0[0].TopFieldOrderCnt = s->refPoc;
        slice.RefPicList0[0].BottomFieldOrderCnt = s->refPoc;
        for (int i = 1; i < 32; ++i) slice.RefPicList0[i].picture_id = VA_INVALID_SURFACE;
    }
    st = updateRender(s, s->bSlice, &slice, sizeof(slice));
    if (st != VA_STATUS_SUCCESS) { vaEndPicture(s->dpy, s->ctx); fail(env, std::string("slice param: ") + vaErrorStr(st)); return env.Null(); }

    st = vaEndPicture(s->dpy, s->ctx);
    if (st != VA_STATUS_SUCCESS) { fail(env, std::string("vaEndPicture: ") + vaErrorStr(st)); return env.Null(); }
    vdbg("submit-ok");
    st = vaSyncSurface(s->dpy, surf);
    if (st != VA_STATUS_SUCCESS) { fail(env, std::string("vaSyncSurface: ") + vaErrorStr(st)); return env.Null(); }
    vdbg("sync-ok");

    // Collect coded slices.
    VACodedBufferSegment *seg = nullptr;
    st = vaMapBuffer(s->dpy, s->codedBuf, (void **)&seg);
    if (st != VA_STATUS_SUCCESS) { fail(env, std::string("vaMapBuffer(coded): ") + vaErrorStr(st)); return env.Null(); }
    std::vector<uint8_t> annexb;
    if (isIdr) {
        // With packed headers the driver embeds SPS/PPS itself; only prepend
        // manually when packed mode is unavailable.
        if (!s->packedMask) {
            annexb.insert(annexb.end(), s->spsAnnexB.begin(), s->spsAnnexB.end());
            annexb.insert(annexb.end(), s->ppsAnnexB.begin(), s->ppsAnnexB.end());
        }
        s->idrCount++;
    }
    static const uint8_t kStart[4] = { 0, 0, 0, 1 };
    auto startsWithCode = [](const uint8_t *b, unsigned n) {
        return (n >= 4 && b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 1) ||
               (n >= 3 && b[0] == 0 && b[1] == 0 && b[2] == 1);
    };
    bool overflow = false;
    for (VACodedBufferSegment *c = seg; c; c = (VACodedBufferSegment *)c->next) {
        if (c->status & VA_CODED_BUF_STATUS_SLICE_OVERFLOW_MASK) overflow = true;
        if (c->size == 0 || !c->buf) continue;
        const uint8_t *b = (const uint8_t *)c->buf;
        // Packed header NALs already carry start codes; only frame raw payloads.
        if (!startsWithCode(b, c->size)) annexb.insert(annexb.end(), kStart, kStart + 4);
        annexb.insert(annexb.end(), b, b + c->size);
    }
    vaUnmapBuffer(s->dpy, s->codedBuf);
    retireFrameBufs(s);
    if (overflow || annexb.empty()) { fail(env, "slice overflow or empty output"); return env.Null(); }

    // The recon scratch becomes the reference for the next P frame.
    s->refSurf = reconSurf;
    s->refFrameNum = fn;
    s->refPoc = poc;
    s->frameCount++;

    return Napi::Buffer<uint8_t>::Copy(env, annexb.data(), annexb.size());
}

Napi::Value Close(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) { fail(env, "close(handle) required"); return env.Null(); }
    int handle = (int)info[0].As<Napi::Number>().Int32Value();
    auto it = g_sessions.find(handle);
    if (it == g_sessions.end()) return Napi::Boolean::New(env, false);
    destroySession(it->second);
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

NODE_API_MODULE(vaapi_encoder, InitModule)

} // namespace
