// src/scripts/lobby.js
// Shared lobby rendering module — used by VR (viewer.js) and desktop preview (?preview=1)

export function createLobbyRenderer(gl) {
    const vsSource = `#version 300 es
in vec3 aPos;
uniform mat4 uMVP;
void main() { gl_Position = uMVP * vec4(aPos, 1.0); }`;

    const fsSource = `#version 300 es
precision highp float;
uniform vec3 uColor;
out vec4 fragColor;
void main() { fragColor = vec4(uColor, 1.0); }`;

    function compile(type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error('[Lobby] shader error:', gl.getShaderInfoLog(s));
            gl.deleteShader(s);
            return null;
        }
        return s;
    }

    const vs = compile(gl.VERTEX_SHADER, vsSource);
    const fs = compile(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return null;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error('[Lobby] link error:', gl.getProgramInfoLog(prog));
        return null;
    }

    const uMVP = gl.getUniformLocation(prog, 'uMVP');
    const uColor = gl.getUniformLocation(prog, 'uColor');

    // Unit cube VAO (36 vertices)
    const cubeVerts = new Float32Array([
        -0.5,-0.5, 0.5,  0.5,-0.5, 0.5,  0.5, 0.5, 0.5,
         0.5, 0.5, 0.5, -0.5, 0.5, 0.5, -0.5,-0.5, 0.5,
        -0.5,-0.5,-0.5, -0.5, 0.5,-0.5,  0.5, 0.5,-0.5,
         0.5, 0.5,-0.5,  0.5,-0.5,-0.5, -0.5,-0.5,-0.5,
        -0.5, 0.5,-0.5, -0.5, 0.5, 0.5,  0.5, 0.5, 0.5,
         0.5, 0.5, 0.5,  0.5, 0.5,-0.5, -0.5, 0.5,-0.5,
        -0.5,-0.5,-0.5,  0.5,-0.5,-0.5,  0.5,-0.5, 0.5,
         0.5,-0.5, 0.5, -0.5,-0.5, 0.5, -0.5,-0.5,-0.5,
         0.5,-0.5,-0.5,  0.5, 0.5,-0.5,  0.5, 0.5, 0.5,
         0.5, 0.5, 0.5,  0.5,-0.5, 0.5,  0.5,-0.5,-0.5,
        -0.5,-0.5,-0.5, -0.5,-0.5, 0.5, -0.5, 0.5, 0.5,
        -0.5, 0.5, 0.5, -0.5, 0.5,-0.5, -0.5,-0.5,-0.5,
    ]);
    const cubeVAO = gl.createVertexArray();
    gl.bindVertexArray(cubeVAO);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, cubeVerts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);

    // Grid floor VAO (lines)
    const gridLines = [];
    const size = 10, step = 1;
    for (let i = -size; i <= size; i += step) {
        gridLines.push(i, 0, i, 0,  i, 0, size, 0,  -size, 0, i, 0,  size, 0, i, 0);
    }
    const gridVAO = gl.createVertexArray();
    gl.bindVertexArray(gridVAO);
    const gvbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, gvbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(gridLines), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    const gridCount = gridLines.length / 3;
    gl.bindVertexArray(null);

    let time = 0;

    function mat4Identity() { const m = new Float32Array(16); m[0]=m[5]=m[10]=m[15]=1; return m; }
    function mat4Translate(m, x, y, z) { const r = new Float32Array(m); r[12]=m[0]*x+m[4]*y+m[8]*z+m[12]; r[13]=m[1]*x+m[5]*y+m[9]*z+m[13]; r[14]=m[2]*x+m[6]*y+m[10]*z+m[14]; r[15]=m[3]*x+m[7]*y+m[11]*z+m[15]; return r; }
    function mat4Scale(m, s) { const r = new Float32Array(m); r[0]*=s; r[5]*=s; r[10]*=s; return r; }
    function mat4Mul(a, b) { const r = new Float32Array(16); for (let i=0;i<4;i++) for (let j=0;j<4;j++) { r[i*4+j]=0; for (let k=0;k<4;k++) r[i*4+j]+=a[i*4+k]*b[k*4+j]; } return r; }
    function mat4Perspective(fov, aspect, near, far) {
        const f = 1/Math.tan(fov/2);
        return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)/(near-far),-1, 0,0,2*far*near/(near-far),0]);
    }

    const ambientPos = [[-1.5,0.3,-2.5],[1.5,-0.2,-3],[-2,0.8,-1.5],[2,0.5,-4],[0,1.2,-3.5],[-1,-0.5,-4.5],[1,0.1,-2],[0,-0.3,-5]];
    const ambientCol = [[0.6,0.2,0.8],[0.2,0.8,0.6],[0.8,0.6,0.2],[0.2,0.4,0.9],[0.9,0.3,0.3],[0.3,0.9,0.5],[0.7,0.7,0.2],[0.5,0.3,0.9]];

    function drawCube(viewProj, pos, scale, color) {
        let model = mat4Identity();
        model = mat4Scale(model, scale);
        model = mat4Translate(model, pos[0], pos[1], pos[2]);
        const mvp = mat4Mul(viewProj, model);
        gl.uniformMatrix4fv(uMVP, false, mvp);
        gl.uniform3fv(uColor, color);
        gl.bindVertexArray(cubeVAO);
        gl.drawArrays(gl.TRIANGLES, 0, 36);
    }

    function drawGrid(viewProj) {
        let model = mat4Identity();
        model[13] = -1.5; // floor at y=-1.5
        const mvp = mat4Mul(viewProj, model);
        gl.uniformMatrix4fv(uMVP, false, mvp);
        gl.uniform3f(uColor, 0.15, 0.15, 0.25);
        gl.bindVertexArray(gridVAO);
        gl.drawArrays(gl.LINES, 0, gridCount);
    }

    return {
        beginFrame(viewMat, projMat) {
            time += 1/60;
            gl.useProgram(prog);
            gl.enable(gl.CULL_FACE);
            gl.enable(gl.DEPTH_TEST);
            gl.disable(gl.BLEND);
            const viewProj = mat4Mul(projMat, viewMat);

            // Grid floor
            drawGrid(viewProj);

            // Ambient floating cubes
            for (let i = 0; i < ambientPos.length; i++) {
                const bob = 0.15 * Math.sin(time * 0.5 + i * 1.2);
                const s = 0.06 + 0.03 * Math.sin(time * 0.3 + i);
                drawCube(viewProj, [ambientPos[i][0], ambientPos[i][1] + bob, ambientPos[i][2]], s, ambientCol[i]);
            }
        },
        drawControllers(viewProj, controllers) {
            for (const c of controllers) {
                drawCube(viewProj, [c.pos.x, c.pos.y, c.pos.z], 0.08, c.handed === 'left' ? [0.2,0.6,0.9] : [0.9,0.4,0.2]);
            }
        },
        endFrame() {
            gl.bindVertexArray(null);
            gl.useProgram(null);
        },
        destroy() {
            gl.deleteProgram(prog);
            gl.deleteVertexArray(cubeVAO);
            gl.deleteVertexArray(gridVAO);
        }
    };
}

// Desktop preview entry point — call from ?preview=1
export function runDesktopPreview(canvas) {
    const gl = canvas.getContext('webgl2');
    if (!gl) return;

    const renderer = createLobbyRenderer(gl);
    if (!renderer) return;

    let yaw = 0, pitch = 0, down = false, lx = 0, ly = 0;
    canvas.addEventListener('mousedown', e => { down = true; lx = e.clientX; ly = e.clientY; });
    window.addEventListener('mousemove', e => {
        if (!down) return;
        yaw -= (e.clientX - lx) * 0.003;
        pitch = Math.max(-Math.PI/2, Math.min(Math.PI/2, pitch - (e.clientY - ly) * 0.003));
        lx = e.clientX; ly = e.clientY;
    });
    window.addEventListener('mouseup', () => { down = false; });
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    function frame() {
        const aspect = canvas.width / canvas.height;
        const proj = mat4Perspective(Math.PI/3, aspect, 0.1, 100);
        const view = mat4Identity();
        const cp = Math.cos(pitch), sp = Math.sin(pitch);
        view[5]=cp; view[6]=sp; view[9]=-sp; view[10]=cp;
        const cy = Math.cos(yaw), sy = Math.sin(yaw);
        const m0 = view[0]*cy + view[8]*sy;
        const m2 = view[2]*cy + view[10]*sy;
        const m8 = view[0]*-sy + view[8]*cy;
        const m10 = view[2]*-sy + view[10]*cy;
        view[0]=m0; view[2]=m2; view[8]=m8; view[10]=m10;

        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0.02, 0.02, 0.08, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        renderer.beginFrame(view, proj);
        renderer.endFrame();

        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
}

function mat4Identity() { const m = new Float32Array(16); m[0]=m[5]=m[10]=m[15]=1; return m; }
function mat4Perspective(fov, aspect, near, far) {
    const f = 1/Math.tan(fov/2);
    return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)/(near-far),-1, 0,0,2*far*near/(near-far),0]);
}