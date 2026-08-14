class NearcadeUpscaler {
    constructor(gl) {
        this.gl = gl;
        this.programs = {};
        this.activeMode = -1;
        this.texture = this.gl.createTexture();
        this.initBase();
        this.initShaders();
    }

    initBase() {
        const gl = this.gl;
        this.buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1,-1,0,1,  1,-1,1,1,  -1,1,0,0,  1,1,1,0
        ]), gl.STATIC_DRAW);

        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    compileShader(type, source) {
        const shader = this.gl.createShader(type);
        this.gl.shaderSource(shader, source);
        this.gl.compileShader(shader);
        if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
            console.error('[Upscaler] Shader compile failed:', this.gl.getShaderInfoLog(shader));
        }
        return shader;
    }

    createProgram(vsSource, fsSource) {
        const vs = this.compileShader(this.gl.VERTEX_SHADER, vsSource);
        const fs = this.compileShader(this.gl.FRAGMENT_SHADER, fsSource);
        const prog = this.gl.createProgram();
        this.gl.attachShader(prog, vs);
        this.gl.attachShader(prog, fs);
        this.gl.linkProgram(prog);
        return prog;
    }

    initShaders() {
        const vsSource = 'attribute vec2 p; attribute vec2 t; varying vec2 v; void main(){gl_Position=vec4(p,0,1);v=t;}';
        
        // Mode 0 & 2: Basic Texture mapping (LINEAR vs NEAREST is handled via texture parameters)
        const basicFs = 'precision mediump float; uniform sampler2D s; varying vec2 v; void main(){gl_FragColor=texture2D(s,v);}';
        this.programs.basic = this.createProgram(vsSource, basicFs);

        // Mode 1: Crisp (Bilinear with slight unsharp mask sharpening)
        const crispFs = `
            precision mediump float;
            uniform sampler2D s;
            uniform vec2 res;
            varying vec2 v;
            void main() {
                vec2 step = 1.0 / res;
                vec4 tex = texture2D(s, v) * 5.0;
                tex -= texture2D(s, v + vec2(-step.x, 0.0));
                tex -= texture2D(s, v + vec2(step.x, 0.0));
                tex -= texture2D(s, v + vec2(0.0, -step.y));
                tex -= texture2D(s, v + vec2(0.0, step.y));
                gl_FragColor = tex;
            }
        `;
        this.programs.crisp = this.createProgram(vsSource, crispFs);

        // Mode 3: Ultra (Bicubic Smooth / Catmull-Rom)
        // High quality mathematical interpolation for removing jagged edges on low-res feeds
        const bicubicFs = `
            precision mediump float;
            uniform sampler2D s;
            uniform vec2 res;
            varying vec2 v;

            vec4 cubic(float v) {
                float n = v * v * v;
                float s2 = v * v;
                vec4 c;
                c.x = -n + 2.0*s2 - v;
                c.y = 3.0*n - 5.0*s2 + 2.0;
                c.z = -3.0*n + 4.0*s2 + v;
                c.w = n - s2;
                return c / 2.0;
            }

            void main() {
                vec2 pt = v * res - 0.5;
                vec2 i = floor(pt);
                vec2 f = pt - i;
                
                vec4 cx = cubic(f.x);
                vec4 cy = cubic(f.y);

                vec2 p0 = (i - 1.0 + 0.5) / res;
                vec2 p1 = (i + 0.5) / res;
                vec2 p2 = (i + 1.0 + 0.5) / res;
                vec2 p3 = (i + 2.0 + 0.5) / res;

                vec4 c0 = cx.x * texture2D(s, vec2(p0.x, p0.y)) + cx.y * texture2D(s, vec2(p1.x, p0.y)) + cx.z * texture2D(s, vec2(p2.x, p0.y)) + cx.w * texture2D(s, vec2(p3.x, p0.y));
                vec4 c1 = cx.x * texture2D(s, vec2(p0.x, p1.y)) + cx.y * texture2D(s, vec2(p1.x, p1.y)) + cx.z * texture2D(s, vec2(p2.x, p1.y)) + cx.w * texture2D(s, vec2(p3.x, p1.y));
                vec4 c2 = cx.x * texture2D(s, vec2(p0.x, p2.y)) + cx.y * texture2D(s, vec2(p1.x, p2.y)) + cx.z * texture2D(s, vec2(p2.x, p2.y)) + cx.w * texture2D(s, vec2(p3.x, p2.y));
                vec4 c3 = cx.x * texture2D(s, vec2(p0.x, p3.y)) + cx.y * texture2D(s, vec2(p1.x, p3.y)) + cx.z * texture2D(s, vec2(p2.x, p3.y)) + cx.w * texture2D(s, vec2(p3.x, p3.y));

                gl_FragColor = cy.x * c0 + cy.y * c1 + cy.z * c2 + cy.w * c3;
            }
        `;
        this.programs.ultra = this.createProgram(vsSource, bicubicFs);

        // Mode 4: FidelityFX Super Resolution 1.0 (FSR EASU pass)
        const fsrFs = `
            precision highp float;
            uniform sampler2D s;
            uniform vec2 res;
            uniform vec2 outRes;
            varying vec2 v;

            vec3 FsrEasuCF(vec2 p) { return texture2D(s, p).rgb; }
            void FsrEasuCon(out vec4 con0, out vec4 con1, out vec4 con2, out vec4 con3, vec2 inputViewportInPixels, vec2 inputSizeInPixels, vec2 outputSizeInPixels) {
                con0 = vec4(inputViewportInPixels.x/outputSizeInPixels.x, inputViewportInPixels.y/outputSizeInPixels.y, .5*inputViewportInPixels.x/outputSizeInPixels.x-.5, .5*inputViewportInPixels.y/outputSizeInPixels.y-.5);
                con1 = vec4(1.0,1.0,1.0,-1.0)/vec4(inputSizeInPixels.x, inputSizeInPixels.y, inputSizeInPixels.x, inputSizeInPixels.y);
                con2 = vec4(-1.0,2.0,1.0,2.0)/vec4(inputSizeInPixels.x, inputSizeInPixels.y, inputSizeInPixels.x, inputSizeInPixels.y);
                con3 = vec4(0.0,4.0,0.0,0.0)/vec4(inputSizeInPixels.x, inputSizeInPixels.y, inputSizeInPixels.x, inputSizeInPixels.y);
            }
            void FsrEasuTapF(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len, float lob, float clp, vec3 c) {
                vec2 v_dir = vec2(dot(off, dir), dot(off,vec2(-dir.y,dir.x)));
                v_dir *= len;
                float d2 = min(dot(v_dir,v_dir),clp);
                float wB = 0.4 * d2 - 1.0; float wA = lob * d2 - 1.0;
                wB *= wB; wA *= wA; wB = 1.5625*wB - 0.5625;
                float w = wB * wA; aC += c*w; aW += w;
            }
            void FsrEasuSetF(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {
                float lenX = max(abs(lD - lC), abs(lC - lB));
                float dirX = lD - lB; dir.x += dirX * w;
                lenX = clamp(abs(dirX)/lenX,0.0,1.0); lenX *= lenX; len += lenX * w;
                float lenY = max(abs(lE - lC), abs(lC - lA));
                float dirY = lE - lA; dir.y += dirY * w;
                lenY = clamp(abs(dirY) / lenY,0.0,1.0); lenY *= lenY; len += lenY * w;
            }
            void FsrEasuF(out vec3 pix, vec2 ip, vec4 con0, vec4 con1, vec4 con2, vec4 con3) {
                vec2 pp = ip * con0.xy + con0.zw; vec2 fp = floor(pp); pp -= fp;
                vec2 p0 = fp * con1.xy + con1.zw; vec2 p1 = p0 + con2.xy; vec2 p2 = p0 + con2.zw; vec2 p3 = p0 + con3.xy;
                vec4 off = vec4(-0.5,0.5,-0.5,0.5) * vec4(con1.x, con1.x, con1.y, con1.y);
                vec3 bC = FsrEasuCF(p0 + off.xw); float bL = bC.g + 0.5 *(bC.r + bC.b);
                vec3 cC = FsrEasuCF(p0 + off.yw); float cL = cC.g + 0.5 *(cC.r + cC.b);
                vec3 iC = FsrEasuCF(p1 + off.xw); float iL = iC.g + 0.5 *(iC.r + iC.b);
                vec3 jC = FsrEasuCF(p1 + off.yw); float jL = jC.g + 0.5 *(jC.r + jC.b);
                vec3 fC = FsrEasuCF(p1 + off.yz); float fL = fC.g + 0.5 *(fC.r + fC.b);
                vec3 eC = FsrEasuCF(p1 + off.xz); float eL = eC.g + 0.5 *(eC.r + eC.b);
                vec3 kC = FsrEasuCF(p2 + off.xw); float kL = kC.g + 0.5 *(kC.r + kC.b);
                vec3 lC = FsrEasuCF(p2 + off.yw); float lL = lC.g + 0.5 *(lC.r + lC.b);
                vec3 hC = FsrEasuCF(p2 + off.yz); float hL = hC.g + 0.5 *(hC.r + hC.b);
                vec3 gC = FsrEasuCF(p2 + off.xz); float gL = gC.g + 0.5 *(gC.r + gC.b);
                vec3 oC = FsrEasuCF(p3 + off.yz); float oL = oC.g + 0.5 *(oC.r + oC.b);
                vec3 nC = FsrEasuCF(p3 + off.xz); float nL = nC.g + 0.5 *(nC.r + nC.b);
                vec2 dir = vec2(0.0); float len = 0.0;
                FsrEasuSetF(dir, len, (1.0-pp.x)*(1.0-pp.y), bL, eL, fL, gL, jL);
                FsrEasuSetF(dir, len,    pp.x  *(1.0-pp.y), cL, fL, gL, hL, kL);
                FsrEasuSetF(dir, len, (1.0-pp.x)*  pp.y  , fL, iL, jL, kL, nL);
                FsrEasuSetF(dir, len,    pp.x  *  pp.y  , gL, jL, kL, lL, oL);
                vec2 dir2 = dir * dir; float dirR = dir2.x + dir2.y;
                bool zro = dirR < (1.0/32768.0); dirR = inversesqrt(dirR);
                dirR = zro ? 1.0 : dirR; dir.x = zro ? 1.0 : dir.x; dir *= vec2(dirR);
                len = len * 0.5; len *= len;
                float stretch = dot(dir,dir) / (max(abs(dir.x), abs(dir.y)));
                vec2 len2 = vec2(1.0 +(stretch-1.0)*len, 1.0 - 0.5 * len);
                float lob = 0.5 - 0.29 * len; float clp = 1.0/lob;
                vec3 min4 = min(min(fC,gC),min(jC,kC)); vec3 max4 = max(max(fC,gC),max(jC,kC));
                vec3 aC = vec3(0.0); float aW = 0.0;
                FsrEasuTapF(aC, aW, vec2( 0.0,-1.0)-pp, dir, len2, lob, clp, bC);
                FsrEasuTapF(aC, aW, vec2( 1.0,-1.0)-pp, dir, len2, lob, clp, cC);
                FsrEasuTapF(aC, aW, vec2(-1.0, 1.0)-pp, dir, len2, lob, clp, iC);
                FsrEasuTapF(aC, aW, vec2( 0.0, 1.0)-pp, dir, len2, lob, clp, jC);
                FsrEasuTapF(aC, aW, vec2( 0.0, 0.0)-pp, dir, len2, lob, clp, fC);
                FsrEasuTapF(aC, aW, vec2(-1.0, 0.0)-pp, dir, len2, lob, clp, eC);
                FsrEasuTapF(aC, aW, vec2( 1.0, 1.0)-pp, dir, len2, lob, clp, kC);
                FsrEasuTapF(aC, aW, vec2( 2.0, 1.0)-pp, dir, len2, lob, clp, lC);
                FsrEasuTapF(aC, aW, vec2( 2.0, 0.0)-pp, dir, len2, lob, clp, hC);
                FsrEasuTapF(aC, aW, vec2( 1.0, 0.0)-pp, dir, len2, lob, clp, gC);
                FsrEasuTapF(aC, aW, vec2( 1.0, 2.0)-pp, dir, len2, lob, clp, oC);
                FsrEasuTapF(aC, aW, vec2( 0.0, 2.0)-pp, dir, len2, lob, clp, nC);
                pix=min(max4,max(min4,aC/aW));
            }
            void main() {
                vec4 con0,con1,con2,con3;
                FsrEasuCon(con0, con1, con2, con3, res, res, outRes);
                vec3 c; vec2 fragCoord = v * outRes;
                FsrEasuF(c, fragCoord, con0, con1, con2, con3);
                gl_FragColor = vec4(c, 1.0);
            }
        `;
        this.programs.fsr = this.createProgram(vsSource, fsrFs);
    }

    setMode(mode) {
        if (this.activeMode === mode) return;
        this.activeMode = mode;
        const gl = this.gl;
        let prog;
        
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        
        if (mode === 2) {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            prog = this.programs.basic;
        } else {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            if (mode === 1) prog = this.programs.crisp;
            else if (mode === 3) prog = this.programs.ultra;
            else if (mode === 4) prog = this.programs.fsr;
            else prog = this.programs.basic;
        }
        
        gl.useProgram(prog);
        this.currentProgram = prog;
        
        const pLoc = gl.getAttribLocation(prog, 'p');
        const tLoc = gl.getAttribLocation(prog, 't');
        
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        if (pLoc >= 0) {
            gl.enableVertexAttribArray(pLoc);
            gl.vertexAttribPointer(pLoc, 2, gl.FLOAT, false, 16, 0);
        }
        if (tLoc >= 0) {
            gl.enableVertexAttribArray(tLoc);
            gl.vertexAttribPointer(tLoc, 2, gl.FLOAT, false, 16, 8);
        }
    }
    
    uploadAndDraw(videoElOrFrame) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoElOrFrame);
        } catch (err) {
            return false; // Skip drawing if frame is not ready
        }
        
        // Pass source resolution to fragment shaders that require pixel calculation
        if (this.activeMode === 1 || this.activeMode === 3 || this.activeMode === 4) {
            const resLoc = gl.getUniformLocation(this.currentProgram, "res");
            if (resLoc) {
                const w = videoElOrFrame.videoWidth || videoElOrFrame.displayWidth || gl.canvas.width;
                const h = videoElOrFrame.videoHeight || videoElOrFrame.displayHeight || gl.canvas.height;
                gl.uniform2f(resLoc, w, h);
            }
            if (this.activeMode === 4) {
                const outResLoc = gl.getUniformLocation(this.currentProgram, "outRes");
                if (outResLoc) gl.uniform2f(outResLoc, gl.canvas.width, gl.canvas.height);
            }
        }
        
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return true;
    }
}

window.NearcadeUpscaler = NearcadeUpscaler;
/**
 * NearcadeUpscalerGPU
 * 
 * WebGPU-based frame upscaler that mirrors the NearcadeUpscaler (WebGL) API.
 * Each mode maps to a WGSL compute shader dispatched on every video frame.
 * 
 * Mode map (same integers as the WebGL upscaler):
 *   0 → Standard (bilinear sample via sampler)
 *   1 → Crisp (bilinear + unsharp mask)
 *   2 → Pixel Perfect (nearest-neighbour)
 *   3 → Ultra (Bicubic / Catmull-Rom)
 *   4 → Ultra+ (FidelityFX Super Resolution 1.0 EASU)
 * 
 * Usage:
 *   const gpu = await NearcadeUpscalerGPU.create(canvas);
 *   if (!gpu) { /* fall back to WebGL *\/ }
 *   gpu.setMode(4);
 *   gpu.uploadAndDraw(videoFrame); // VideoFrame or HTMLVideoElement
 */
class NearcadeUpscalerGPU {
    constructor(device, canvas, context, format) {
        this.device = device;
        this.canvas = canvas;
        this.context = context;
        this.format = format;
        this.activeMode = -1;
        this._pipelines = {};
        this._sampler = null;
        this._texture = null;
        this._textureW = 0;
        this._textureH = 0;
    }

    /** Factory — returns null if WebGPU is unavailable or the adapter fails. */
    static async create(canvas) {
        try {
            if (!navigator.gpu) return null;
            const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
            if (!adapter) return null;
            const device = await adapter.requestDevice();
            const format = navigator.gpu.getPreferredCanvasFormat();
            const context = canvas.getContext('webgpu');
            if (!context) return null;
            context.configure({ device, format, alphaMode: 'opaque' });
            const inst = new NearcadeUpscalerGPU(device, canvas, context, format);
            await inst._init();
            return inst;
        } catch (e) {
            console.warn('[UpscalerGPU] Initialization failed:', e);
            return null;
        }
    }

    async _init() {
        const device = this.device;

        // ── Shared sampler (LINEAR / NEAREST switched per pipeline) ─────────
        this._linearSampler = device.createSampler({
            magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'
        });
        this._nearestSampler = device.createSampler({
            magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'
        });

        // ── Bind group layout shared by all fragment-style render pipelines ──
        this._bgl = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ]
        });

        // ── Resolution uniform buffer (vec2f srcRes + vec2f dstRes) ──────────
        this._uniformBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

        // ── Compile all pipeline shaders ─────────────────────────────────────
        await Promise.all([
            this._buildPipeline('standard', this._wgslStandard()),
            this._buildPipeline('crisp',    this._wgslCrisp()),
            this._buildPipeline('nearest',  this._wgslStandard()),   // same shader, different sampler
            this._buildPipeline('ultra',    this._wgslUltra()),
            this._buildPipeline('fsr',      this._wgslFsr()),
        ]);
    }

    async _buildPipeline(name, fsWgsl) {
        const device = this.device;
        const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this._bgl] });

        const vertModule = device.createShaderModule({ code: this._wgslVert() });
        const fragModule = device.createShaderModule({ code: fsWgsl });

        this._pipelines[name] = device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: { module: vertModule, entryPoint: 'vs_main' },
            fragment: {
                module: fragModule,
                entryPoint: 'fs_main',
                targets: [{ format: this.format }]
            },
            primitive: { topology: 'triangle-strip' }
        });
    }

    // ── Shader Sources (WGSL) ─────────────────────────────────────────────────

    _wgslVert() { return /* wgsl */`
        struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
        @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
            // Full-screen triangle strip (4 verts)
            let x = select(-1.0, 1.0, vi == 1u || vi == 3u);
            let y = select(-1.0, 1.0, vi == 2u || vi == 3u);
            let u = select(0.0, 1.0, vi == 1u || vi == 3u);
            let v = select(1.0, 0.0, vi == 2u || vi == 3u);
            return VSOut(vec4f(x, y, 0.0, 1.0), vec2f(u, v));
        }
    `; }

    _wgslStandard() { return /* wgsl */`
        @group(0) @binding(0) var samp: sampler;
        @group(0) @binding(1) var tex: texture_2d<f32>;
        @group(0) @binding(2) var<uniform> res: vec4f; // xy=srcRes, zw=dstRes
        struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
        @fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
            return textureSample(tex, samp, in.uv);
        }
    `; }

    _wgslCrisp() { return /* wgsl */`
        @group(0) @binding(0) var samp: sampler;
        @group(0) @binding(1) var tex: texture_2d<f32>;
        @group(0) @binding(2) var<uniform> res: vec4f;
        struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
        @fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
            let step = 1.0 / res.xy;
            var c = textureSample(tex, samp, in.uv) * 5.0;
            c -= textureSample(tex, samp, in.uv + vec2f(-step.x,     0.0));
            c -= textureSample(tex, samp, in.uv + vec2f( step.x,     0.0));
            c -= textureSample(tex, samp, in.uv + vec2f(    0.0, -step.y));
            c -= textureSample(tex, samp, in.uv + vec2f(    0.0,  step.y));
            return vec4f(clamp(c.rgb, vec3f(0.0), vec3f(1.0)), 1.0);
        }
    `; }

    _wgslUltra() { return /* wgsl */`
        // Bicubic Catmull-Rom upscaler
        @group(0) @binding(0) var samp: sampler;
        @group(0) @binding(1) var tex: texture_2d<f32>;
        @group(0) @binding(2) var<uniform> res: vec4f;
        struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

        fn cubic(t: f32) -> vec4f {
            let t2 = t * t; let t3 = t2 * t;
            return vec4f(-t3 + 2.0*t2 - t, 3.0*t3 - 5.0*t2 + 2.0, -3.0*t3 + 4.0*t2 + t, t3 - t2) * 0.5;
        }

        @fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
            let pt  = in.uv * res.xy - 0.5;
            let i   = floor(pt);
            let f   = pt - i;
            let cx  = cubic(f.x);
            let cy  = cubic(f.y);
            let p0  = (i - 1.0 + 0.5) / res.xy;
            let p1  = (i       + 0.5) / res.xy;
            let p2  = (i + 1.0 + 0.5) / res.xy;
            let p3  = (i + 2.0 + 0.5) / res.xy;
            let r0  = cx.x*textureSample(tex,samp,vec2f(p0.x,p0.y)) + cx.y*textureSample(tex,samp,vec2f(p1.x,p0.y)) + cx.z*textureSample(tex,samp,vec2f(p2.x,p0.y)) + cx.w*textureSample(tex,samp,vec2f(p3.x,p0.y));
            let r1  = cx.x*textureSample(tex,samp,vec2f(p0.x,p1.y)) + cx.y*textureSample(tex,samp,vec2f(p1.x,p1.y)) + cx.z*textureSample(tex,samp,vec2f(p2.x,p1.y)) + cx.w*textureSample(tex,samp,vec2f(p3.x,p1.y));
            let r2  = cx.x*textureSample(tex,samp,vec2f(p0.x,p2.y)) + cx.y*textureSample(tex,samp,vec2f(p1.x,p2.y)) + cx.z*textureSample(tex,samp,vec2f(p2.x,p2.y)) + cx.w*textureSample(tex,samp,vec2f(p3.x,p2.y));
            let r3  = cx.x*textureSample(tex,samp,vec2f(p0.x,p3.y)) + cx.y*textureSample(tex,samp,vec2f(p1.x,p3.y)) + cx.z*textureSample(tex,samp,vec2f(p2.x,p3.y)) + cx.w*textureSample(tex,samp,vec2f(p3.x,p3.y));
            return vec4f(clamp((cy.x*r0 + cy.y*r1 + cy.z*r2 + cy.w*r3).rgb, vec3f(0.0), vec3f(1.0)), 1.0);
        }
    `; }

    _wgslFsr() { return /* wgsl */`
        // FSR 1.0 EASU (Edge Adaptive Spatial Upsampling) — WGSL port
        @group(0) @binding(0) var samp: sampler;
        @group(0) @binding(1) var tex: texture_2d<f32>;
        @group(0) @binding(2) var<uniform> res: vec4f; // xy=srcRes, zw=dstRes
        struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

        fn luma(c: vec3f) -> f32 { return c.g + 0.5*(c.r + c.b); }

        fn tap(p: vec2f) -> vec3f { return textureSample(tex, samp, p).rgb; }

        fn easu_set(dir: ptr<function,vec2f>, len: ptr<function,f32>, w: f32,
                    lA: f32, lB: f32, lC: f32, lD: f32, lE: f32) {
            let lenXv = max(abs(lD-lC), abs(lC-lB));
            let dirX  = lD - lB; (*dir).x += dirX * w;
            let lnX   = clamp(abs(dirX)/lenXv, 0.0, 1.0); *len += lnX*lnX*w;
            let lenYv = max(abs(lE-lC), abs(lC-lA));
            let dirY  = lE - lA; (*dir).y += dirY * w;
            let lnY   = clamp(abs(dirY)/lenYv, 0.0, 1.0); *len += lnY*lnY*w;
        }

        fn easu_tap(aC: ptr<function,vec3f>, aW: ptr<function,f32>,
                    off: vec2f, dir: vec2f, len2: vec2f, lob: f32, clp: f32, c: vec3f) {
            let v   = vec2f(dot(off, dir), dot(off, vec2f(-dir.y, dir.x))) * len2;
            let d2  = min(dot(v, v), clp);
            let wB  = 0.4*d2 - 1.0; let wA = lob*d2 - 1.0;
            let wb2 = wB*wB; let wa2 = wA*wA;
            let wb3 = 1.5625*wb2 - 0.5625;
            let wt  = wb3 * wa2;
            *aC += c * wt; *aW += wt;
        }

        @fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
            let ip     = in.uv * res.zw;
            let scaleX = res.x / res.z; let scaleY = res.y / res.w;
            let pp     = ip * vec2f(scaleX, scaleY) + vec2f(0.5*scaleX - 0.5, 0.5*scaleY - 0.5);
            let fp     = floor(pp); let frac = pp - fp;
            let step   = 1.0 / res.xy;
            let p0     = fp * step + step * 0.5;
            let p1     = p0 + step; let p2 = p0 + 2.0*step; let pm = p0 - step;

            let bC = tap(vec2f(p0.x,  pm.y)); let bL = luma(bC);
            let cC = tap(vec2f(p1.x,  pm.y)); let cL = luma(cC);
            let iC = tap(vec2f(pm.x,  p0.y)); let iL = luma(iC);
            let jC = tap(vec2f(p0.x,  p0.y)); let jL = luma(jC);
            let fC = tap(vec2f(p1.x,  p0.y)); let fL = luma(fC);
            let eC = tap(vec2f(p2.x,  p0.y)); let eL = luma(eC);
            let kC = tap(vec2f(pm.x,  p1.y)); let kL = luma(kC);
            let lC = tap(vec2f(p0.x,  p1.y)); let lL = luma(lC);
            let gC = tap(vec2f(p1.x,  p1.y)); let gL = luma(gC);
            let hC = tap(vec2f(p2.x,  p1.y)); let hL = luma(hC);
            let nC = tap(vec2f(p0.x,  p2.y)); let nL = luma(nC);
            let oC = tap(vec2f(p1.x,  p2.y)); let oL = luma(oC);

            var dir = vec2f(0.0); var len = 0.0;
            easu_set(&dir, &len, (1.0-frac.x)*(1.0-frac.y), bL, iL, jL, kL, lL);
            easu_set(&dir, &len,      frac.x *(1.0-frac.y), cL, jL, fC.r, lL, gL);
            easu_set(&dir, &len, (1.0-frac.x)*     frac.y , jL, kL, lL, nL, oL);
            easu_set(&dir, &len,      frac.x *     frac.y , fL, lL, gL, oL, nL);

            let dirR2  = dot(dir, dir);
            let zro    = dirR2 < (1.0/32768.0);
            let dirR   = select(inverseSqrt(dirR2), 1.0, zro);
            let dN     = select(dir * dirR, vec2f(1.0, 0.0), zro);

            let lenF = len * 0.5; let lenF2 = lenF * lenF;
            let stretch = dot(dN, dN) / max(abs(dN.x), abs(dN.y));
            let len2 = vec2f(1.0 + (stretch-1.0)*lenF2, 1.0 - 0.5*lenF2);
            let lob  = 0.5 - 0.29*lenF2;
            let clp  = 1.0 / lob;

            let mn4 = min(min(fC, gC), min(jC, lC));
            let mx4 = max(max(fC, gC), max(jC, lC));

            var aC = vec3f(0.0); var aW = 0.0;
            easu_tap(&aC, &aW, vec2f( 0.0,-1.0)-frac, dN, len2, lob, clp, bC);
            easu_tap(&aC, &aW, vec2f( 1.0,-1.0)-frac, dN, len2, lob, clp, cC);
            easu_tap(&aC, &aW, vec2f(-1.0, 1.0)-frac, dN, len2, lob, clp, kC);
            easu_tap(&aC, &aW, vec2f( 0.0, 1.0)-frac, dN, len2, lob, clp, lC);
            easu_tap(&aC, &aW, vec2f( 0.0, 0.0)-frac, dN, len2, lob, clp, jC);
            easu_tap(&aC, &aW, vec2f(-1.0, 0.0)-frac, dN, len2, lob, clp, iC);
            easu_tap(&aC, &aW, vec2f( 1.0, 1.0)-frac, dN, len2, lob, clp, gC);
            easu_tap(&aC, &aW, vec2f( 2.0, 1.0)-frac, dN, len2, lob, clp, hC);
            easu_tap(&aC, &aW, vec2f( 2.0, 0.0)-frac, dN, len2, lob, clp, eC);
            easu_tap(&aC, &aW, vec2f( 1.0, 0.0)-frac, dN, len2, lob, clp, fC);
            easu_tap(&aC, &aW, vec2f( 1.0, 2.0)-frac, dN, len2, lob, clp, oC);
            easu_tap(&aC, &aW, vec2f( 0.0, 2.0)-frac, dN, len2, lob, clp, nC);

            let pix = clamp(min(mx4, max(mn4, aC / aW)), vec3f(0.0), vec3f(1.0));
            return vec4f(pix, 1.0);
        }
    `; }

    // ── Public API (mirrors NearcadeUpscaler) ─────────────────────────────────

    setMode(mode) {
        this.activeMode = mode;
    }

    /** Upload source frame and render via the active pipeline.
     *  source: HTMLVideoElement | VideoFrame | ImageBitmap | HTMLCanvasElement
     *  Returns false if frame is not ready. */
    uploadAndDraw(source) {
        const w = source.videoWidth || source.codedWidth || source.width || 0;
        const h = source.videoHeight || source.codedHeight || source.height || 0;
        if (!w || !h) return false;

        const device = this.device;
        const mode   = this.activeMode;

        // Determine which pipeline + sampler to use
        let pipeKey, sampler;
        if (mode === 2) {
            pipeKey = 'nearest'; sampler = this._nearestSampler;
        } else if (mode === 1) {
            pipeKey = 'crisp';   sampler = this._linearSampler;
        } else if (mode === 3) {
            pipeKey = 'ultra';   sampler = this._linearSampler;
        } else if (mode === 4) {
            pipeKey = 'fsr';     sampler = this._linearSampler;
        } else {
            pipeKey = 'standard'; sampler = this._linearSampler;
        }

        // (Re)create texture if dimensions changed
        if (!this._texture || this._textureW !== w || this._textureH !== h) {
            this._texture?.destroy();
            this._texture = device.createTexture({
                size: [w, h, 1],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
            });
            this._textureW = w; this._textureH = h;
        }

        // Upload frame using copyExternalImageToTexture
        try {
            device.queue.copyExternalImageToTexture(
                { source, flipY: false },
                { texture: this._texture },
                [w, h]
            );
        } catch (e) {
            return false; // Frame not ready yet
        }

        // Update uniform: srcRes, dstRes
        const uniforms = new Float32Array([w, h, this.canvas.width, this.canvas.height]);
        device.queue.writeBuffer(this._uniformBuf, 0, uniforms);

        // Build bind group for this draw
        const bindGroup = device.createBindGroup({
            layout: this._bgl,
            entries: [
                { binding: 0, resource: sampler },
                { binding: 1, resource: this._texture.createView() },
                { binding: 2, resource: { buffer: this._uniformBuf } },
            ]
        });

        // Encode + submit render pass
        const encoder    = device.createCommandEncoder();
        const passDesc   = {
            colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                loadOp: 'clear', storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 }
            }]
        };
        const pass = encoder.beginRenderPass(passDesc);
        pass.setPipeline(this._pipelines[pipeKey]);
        pass.setBindGroup(0, bindGroup);
        pass.draw(4);
        pass.end();
        device.queue.submit([encoder.finish()]);

        return true;
    }

    destroy() {
        this._texture?.destroy();
        this._uniformBuf?.destroy();
        this.context?.unconfigure?.();
    }
}

window.NearcadeUpscalerGPU = NearcadeUpscalerGPU;
