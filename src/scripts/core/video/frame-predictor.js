// #12: Client-side frame prediction — Tier 2 motion-vector based
// Uses WebGL to warp the previous decoded frame in response to viewer input,
// providing instant visual feedback while waiting for the real frame.

class FramePredictor {
    constructor() {
        this.prevFrame = null;        // ImageData from last decoded frame
        this.motionVectors = null;    // Float32Array [dx, dy] per block
        this.blockSize = 16;          // 16x16 macroblock
        this.width = 0;
        this.height = 0;
        this.canvas = null;
        this.gl = null;
        this.warpProgram = null;
        this.initialized = false;
        this.predicting = false;
    }

    init(width, height) {
        this.width = width;
        this.height = height;
        this.blockCols = Math.ceil(width / this.blockSize);
        this.blockRows = Math.ceil(height / this.blockSize);

        // Set up offscreen canvas for WebGL warping
        this.canvas = document.createElement('canvas');
        this.canvas.width = width;
        this.canvas.height = height;
        this.gl = this.canvas.getContext('webgl');
        if (!this.gl) {
            console.warn('[FramePredictor] WebGL unavailable');
            return false;
        }

        this._initShaders();
        this.initialized = true;
        return true;
    }

    _initShaders() {
        const gl = this.gl;

        // Vertex shader: passes through positions with motion offset
        const vsSrc = `
            attribute vec2 aPos;
            attribute vec2 aUv;
            uniform vec2 uMotion;
            varying vec2 vUv;
            void main() {
                vUv = aUv + uMotion;
                gl_Position = vec4(aPos, 0.0, 1.0);
            }
        `;

        // Fragment shader: samples previous frame at warped UV
        const fsSrc = `
            precision highp float;
            uniform sampler2D uTexture;
            varying vec2 vUv;
            void main() {
                gl_FragColor = texture2D(uTexture, vUv);
            }
        `;

        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, vsSrc);
        gl.compileShader(vs);

        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, fsSrc);
        gl.compileShader(fs);

        this.warpProgram = gl.createProgram();
        gl.attachShader(this.warpProgram, vs);
        gl.attachShader(this.warpProgram, fs);
        gl.linkProgram(this.warpProgram);

        // Full-screen quad
        this.quadBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1, 0, 0,
             1, -1, 1, 0,
            -1,  1, 0, 1,
             1,  1, 1, 1,
        ]), gl.STATIC_DRAW);
    }

    // Store the latest decoded frame for prediction
    updateReference(frame) {
        if (!this.initialized || !frame) return;
        this.prevFrame = frame; // VideoFrame or ImageData
        this.predicting = false;
    }

    // Called when viewer sends an input — generate predicted frame
    predict(inputDelta) {
        if (!this.initialized || !this.prevFrame || !this.gl) return null;
        if (!inputDelta || (inputDelta.dx === 0 && inputDelta.dy === 0)) return null;

        const gl = this.gl;

        // Scale input delta to UV motion (normalize by dimensions)
        const uMotionX = -(inputDelta.dx || 0) / this.width;
        const uMotionY = (inputDelta.dy || 0) / this.height;

        // Clamp motion magnitude to prevent tearing
        const maxMotion = 0.1; // Max 10% of screen per prediction
        const clampedX = Math.max(-maxMotion, Math.min(maxMotion, uMotionX));
        const clampedY = Math.max(-maxMotion, Math.min(maxMotion, uMotionY));

        // Upload previous frame as texture
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.prevFrame);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // Render warped frame
        gl.useProgram(this.warpProgram);
        gl.uniform2f(gl.getUniformLocation(this.warpProgram, 'uMotion'), clampedX, clampedY);
        gl.uniform1i(gl.getUniformLocation(this.warpProgram, 'uTexture'), 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        const aPos = gl.getAttribLocation(this.warpProgram, 'aPos');
        const aUv = gl.getAttribLocation(this.warpProgram, 'aUv');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(aUv);
        gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // Read back the predicted frame
        const pixels = new Uint8Array(this.width * this.height * 4);
        gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        // Clean up
        gl.deleteTexture(texture);

        this.predicting = true;
        return new ImageData(new Uint8ClampedArray(pixels), this.width, this.height);
    }

    // Render a predicted frame to a given canvas context
    renderPrediction(ctx, predictedFrame) {
        if (!predictedFrame || !ctx) return;
        ctx.putImageData(predictedFrame, 0, 0);
    }

    destroy() {
        if (this.gl && this.warpProgram) {
            this.gl.deleteProgram(this.warpProgram);
        }
        this.canvas = null;
        this.gl = null;
        this.prevFrame = null;
        this.initialized = false;
    }
}

// Singleton export
const predictor = new FramePredictor();
module.exports = predictor;
