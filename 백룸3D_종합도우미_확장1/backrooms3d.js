// 백룸 3D 종합 도우미 — 완전 3D 그리기
// 완전 3D: 벽·바닥·천장·조명은 진짜 3D로 그리고, 괴물·가구·열차는 깊이를 가진 판으로 3D 공간에 되돌려 놓아
//    벽 뒤에 있는 부분은 깊이 버퍼가 가려 준다(벽을 뚫고 보이는 일이 없다).
(function () {
    'use strict';
    if (window.__BR3D_LOADED) return;
    window.__BR3D_LOADED = true;
    const THREE = window.THREE;
    const N = 70, P = 330, NEAR = 0.04, FAR = 60;
    const DOOR = 641, SIDE = 769, OPEN = 897;
    const WORLD = ['벽', '바닥과 천장', '하늘', '조명', '괴물', '가구', '열차'];
    const BILL = { '괴물': 0.3, '열차': 0.8 };      // 이름: 앞으로 당기는 거리(가구는 진짜 3D 모델로 따로 그린다)
    const LIT = { 1: 'br', 2: 'lab', 6: 'hang', 7: 'sub', 9: 'lab' };
    const LT_IDX = { br: 0, lab: 6, sub: 12, hang: 24, glow_br: 26, glow_lab: 27, glow_sub: 28 };
    const C2 = [[0, 0], [1, 1], [1, 0], [0, 1]], C4 = [[1, 1], [1, 0], [0, 1], [2, 1], [1, 2], [0, 0], [2, 2]];

    let want3d = false, active = false;
    function readSetting() { want3d = document.documentElement.dataset.br3d === '1'; }
    document.addEventListener('br3d-setting', readSetting);
    readSetting();

    // ---------------------------------------------------------------- 엔트리 값 읽기
    let VC = {}, LC = {}, OC = {}, frame = 0;
    function vobj(n) {
        let v = VC[n];
        if (v === undefined) { v = Entry.variableContainer.getVariableByName(n) || null; VC[n] = v; }
        return v;
    }
    function gv(n, d = 0) { const v = vobj(n); if (!v) return d; const x = Number(v.getValue()); return isNaN(x) ? d : x; }
    function sv(n, x) { const v = vobj(n); if (v && Number(v.getValue()) !== x) v.setValue(x); }
    function list(n) {
        let l = LC[n];
        if (l === undefined) { l = (Entry.variableContainer.lists_ || []).find((x) => x.name_ === n) || null; LC[n] = l; }
        return l;
    }
    function obj(n) {
        let o = OC[n];
        if (o === undefined) { o = (Entry.container.objects_ || []).find((x) => x.name === n) || null; OC[n] = o; }
        return o;
    }
    function isGame() { return !!(list('지도') && vobj('posX') && vobj('각도') && obj('벽')); }
    function localVar(e, n) {
        const key = '__br3d_' + n;
        if (!e[key]) e[key] = (e.variables || []).find((x) => x.name_ === n) || null;
        return e[key] ? Number(e[key].getValue()) : NaN;
    }
    function imgSrc(p) {
        if (!p) return null;
        if (p.fileurl) return p.fileurl;
        if (!p.filename) return null;
        const f = p.filename;
        return `${Entry.defaultPath || ''}/uploads/${f.substring(0, 2)}/${f.substring(2, 4)}/image/${f}.${p.imageType === 'svg' ? 'svg' : 'png'}`;
    }
    const imgCache = new Map();
    function loadImg(url) {
        let r = imgCache.get(url);
        if (r) return r;
        const im = new Image();
        r = { im, ok: false };
        im.crossOrigin = 'anonymous';
        im.onload = () => { r.ok = true; };
        im.onerror = () => { if (im.crossOrigin) { im.crossOrigin = null; im.src = url + (url.includes('?') ? '&' : '?') + 'br3d'; } };
        im.src = url;
        imgCache.set(url, r);
        return r;
    }
    const texCache = new Map();
    function texFromUrl(url) {
        let t = texCache.get(url);
        if (t) return t.ready ? t.tex : null;
        const r = loadImg(url);
        t = { tex: new THREE.Texture(r.im), ready: false };
        t.tex.minFilter = THREE.LinearFilter; t.tex.generateMipmaps = false;
        texCache.set(url, t);
        const poll = () => { if (r.ok) { t.tex.needsUpdate = true; t.ready = true; } else setTimeout(poll, 50); };
        poll();
        return null;
    }

    // ---------------------------------------------------------------- 3D 준비
    let furnGroup = null, furnList = [];
    let gl = null, renderer, scene, camW, camB, sceneB, worldGroup, lightGroup, flickGroup, skyMesh, glc, entryCanvas;
    const worldMats = [];
    function makeWorldMat(tex, opts = {}) {
        const m = new THREE.ShaderMaterial({
            uniforms: { map: { value: tex }, glowOn: { value: 1 }, flat: { value: opts.flat || 0 }, hideCell: { value: -9 } },
            vertexShader: `attribute float shade; attribute float glow; attribute float cid; varying vec2 vUv; varying float vD; varying float vS; varying float vG; varying float vC;
                void main(){ vUv=uv; vS=shade; vG=glow; vC=cid; vec4 mv=modelViewMatrix*vec4(position,1.0); vD=-mv.z; gl_Position=projectionMatrix*mv; }`,
            fragmentShader: `uniform sampler2D map; uniform float glowOn; uniform float hideCell; varying vec2 vUv; varying float vD; varying float vS; varying float vG; varying float vC;
                void main(){ if(abs(vC-hideCell)<0.5) discard; vec4 t=texture2D(map,vUv); if(t.a<0.5) discard;
                  float b=-7.4*min(vD,9.0)-4.0*max(vD-9.0,0.0)+vS+vG*glowOn;
                  gl_FragColor=vec4(t.rgb+b/255.0,1.0); }`,
            side: THREE.DoubleSide,
        });
        worldMats.push(m);
        return m;
    }
    function makeDecalMat(tex) {
        return new THREE.ShaderMaterial({
            uniforms: { map: { value: tex }, dim: { value: 1 } },
            vertexShader: `varying vec2 vUv; varying float vD; void main(){ vUv=uv; vec4 mv=modelViewMatrix*vec4(position,1.0); vD=-mv.z; gl_Position=projectionMatrix*mv; }`,
            fragmentShader: `uniform sampler2D map; uniform float dim; varying vec2 vUv; varying float vD;
                void main(){ vec4 t=texture2D(map,vUv); float f=clamp(1.0-vD*0.055,0.0,1.0); gl_FragColor=vec4(t.rgb*dim, t.a*f*(0.45+0.55*dim)); }`,
            transparent: true, depthWrite: false, side: THREE.DoubleSide,
        });
    }
    const billMat = () => new THREE.ShaderMaterial({
        uniforms: { map: { value: null }, add: { value: 0 }, alpha: { value: 1 }, flipX: { value: 0 } },
        vertexShader: `uniform float flipX; varying vec2 vUv; void main(){ vUv=vec2(flipX>0.5?1.0-uv.x:uv.x, uv.y); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        fragmentShader: `uniform sampler2D map; uniform float add; uniform float alpha; varying vec2 vUv;
            void main(){ vec4 t=texture2D(map,vUv); if(t.a<0.02) discard; gl_FragColor=vec4(t.rgb+add,t.a*alpha); if(gl_FragColor.a<0.02) discard; }`,
        transparent: true, depthWrite: true, side: THREE.DoubleSide,
    });
    function setup() {
        glc = document.createElement('canvas');
        glc.id = 'br3dCanvas';
        glc.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:-1;display:none;';
        renderer = new THREE.WebGLRenderer({ canvas: glc, antialias: true, alpha: false, preserveDrawingBuffer: false });
        renderer.setPixelRatio(1);
        renderer.autoClear = false;
        renderer.setClearColor(0x000000, 1);
        scene = new THREE.Scene(); sceneB = new THREE.Scene();
        worldGroup = new THREE.Group(); lightGroup = new THREE.Group(); flickGroup = new THREE.Group();
        furnGroup = new THREE.Group();
        scene.add(worldGroup); scene.add(lightGroup); scene.add(flickGroup); scene.add(furnGroup);
        camW = new THREE.Camera(); camW.matrixAutoUpdate = false;
        camB = new THREE.Camera(); camB.matrixAutoUpdate = false;
        gl = true;
    }
    function attach() {
        const c = document.getElementById('entryCanvas') || (Entry.stage._app && Entry.stage._app.view) || (Entry.stage.canvas && Entry.stage.canvas.canvas);
        if (!c || !c.parentNode) return false;
        if (c !== entryCanvas) {
            entryCanvas = c;
            const par = c.parentNode;
            if (getComputedStyle(par).position === 'static') par.style.position = 'relative';
            par.style.isolation = 'isolate';
            par.insertBefore(glc, c);
            if (c.__br3dBg === undefined) c.__br3dBg = c.style.backgroundColor;
            c.style.backgroundColor = 'transparent';
        }
        return true;
    }
    function syncSize() {
        const c = entryCanvas, par = c.parentNode;
        const r = c.getBoundingClientRect(), pr = par.getBoundingClientRect();
        const left = r.left - pr.left - par.clientLeft + par.scrollLeft, top = r.top - pr.top - par.clientTop + par.scrollTop;
        const s = glc.style;
        if (s.left !== left + 'px') s.left = left + 'px';
        if (s.top !== top + 'px') s.top = top + 'px';
        if (s.width !== r.width + 'px') s.width = r.width + 'px';
        if (s.height !== r.height + 'px') s.height = r.height + 'px';
        const w = Math.max(2, Math.round(Math.min(c.width, r.width * (window.devicePixelRatio || 1)))), h = Math.round(w * 270 / 480);
        if (glc.width !== w || glc.height !== h) renderer.setSize(w, h, false);
    }

    // ---------------------------------------------------------------- 지도 → 벽 기하
    const wallTexCache = new Map();
    function wallTexture(base) {
        let t = wallTexCache.get(base);
        if (t) return t;
        const pics = obj('벽').pictures;
        const cv = document.createElement('canvas'); cv.width = 160; cv.height = 256;
        const tex = new THREE.CanvasTexture(cv);
        tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.anisotropy = 4;
        t = tex; wallTexCache.set(base, t);
        const ctx = cv.getContext('2d');
        let left = 16;
        for (let u = 0; u < 16; u++) {
            const p = pics[base + u];
            const url = imgSrc(p);
            if (!url) { left--; continue; }
            const r = loadImg(url);
            const draw = () => { if (r.ok) { ctx.drawImage(r.im, u * 10, 0, 10, 256); tex.needsUpdate = true; } else setTimeout(draw, 60); };
            draw();
        }
        return t;
    }
    let mapSig = '', M = null, LV = 0, GS = 2;
    function readMap() {
        const arr = list('지도').getArray();
        const m = new Float64Array(N * N);
        let h = 0;
        for (let i = 0; i < N * N; i++) { const x = Number(arr[i] ? arr[i].data : 1) || 0; m[i] = x; h = (h * 31 + x * (i % 89 + 1)) % 1000000007; }
        return { m, sig: h + ':' + gv('단계') + ':' + gv('층') };
    }
    const cell = (x, y) => (x < 0 || y < 0 || x >= N || y >= N) ? 1 : M[y * N + x];
    const solid = (v) => v > 0 && v <= 9000;
    function lpick(bx, by) {
        if (bx < 0 || by < 0) return null;
        const l0x = bx * GS, l0y = by * GS;
        if (!(l0x < N - 3 && l0y < N - 3)) return null;
        if (((bx * 7 + by * 13 + LV * 5) % 11) === 0) return null;
        for (const [a, b] of (GS === 2 ? C2 : C4)) if (M[(l0y + b) * N + l0x + a] === 0) return [l0x + a + 0.5, l0y + b + 0.5, (bx * 7 + by * 13 + LV * 5) % 11];
        return null;
    }
    function glowAt(x, z) {
        if (!LIT[LV]) return 0;
        const L = lpick(Math.floor(x / GS), Math.floor(z / GS));
        if (!L) return 0;
        const d2 = (x - L[0]) ** 2 + (z - L[1]) ** 2;
        return d2 < 1.8 ? 26 - 14 * d2 : 0;
    }
    // ---------------------------------------------------------------- 게임 안과 같은 낮은 다각형 모형(f3.js): 계단
    const F3 = window.__BR3D_F3 || null;
    function stairsDown() { const L = gv('단계'), fl = gv('층'); return (L === 4 && fl >= 5) || (L === 7 && fl === 1); }
    function colMat() {
        return new THREE.ShaderMaterial({
            vertexShader: `attribute vec3 color; varying vec3 vC; varying float vD; void main(){ vC=color; vec4 mv=modelViewMatrix*vec4(position,1.0); vD=-mv.z; gl_Position=projectionMatrix*mv; }`,
            fragmentShader: `varying vec3 vC; varying float vD; void main(){ float b=-7.4*min(vD,9.0)-4.0*max(vD-9.0,0.0); gl_FragColor=vec4(vC+b/255.0,1.0); }`,
            side: THREE.DoubleSide,
        });
    }
    function hexaGeo(name, skip) {
        if (!F3) return null;
        const mi = F3.names.indexOf(name); if (mi < 0) return null;
        const p = [], c = [], idx = [];
        const pal = (k, sh) => F3.pal[k].map((v) => v / 255 * sh);
        for (let h = F3.start[mi], n = 0; n < F3.count[mi]; h++, n++) {
            if (skip && skip.includes(n)) continue;
            const d = F3.hexa.slice(h * 20, h * 20 + 20);
            const [top, side, y0, y1, ts, cx, cz] = d; const pts = [];
            for (let i = 0; i < 4; i++) pts.push([d[7 + i * 2], d[8 + i * 2]]);
            const B = pts.map(([x, z]) => [x, y0, z]), Tq = pts.map(([x, z]) => [cx + (x - cx) * ts, y1, cz + (z - cz) * ts]);
            const quad = (a, b2, c2, d2, col) => { const s0 = p.length / 3; for (const v of [a, b2, c2, d2]) { p.push(...v); c.push(...col); } idx.push(s0, s0 + 1, s0 + 2, s0, s0 + 2, s0 + 3); };
            for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; quad(B[i], B[j], Tq[j], Tq[i], pal(side, d[16 + i])); }
            quad(Tq[0], Tq[1], Tq[2], Tq[3], pal(top, 1)); quad(B[0], B[1], B[2], B[3], pal(top, d[15] === 2 ? 1.15 : 0.45));
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3)); g.setIndex(idx);
        return g;
    }
    let COLMAT = null;
    function buildStairs(cx, cz, down) {
        const L = gv('단계');
        const name = (down ? 'stairs_down_' : 'stairs_up_') + (L === 4 ? 'apt' : 'sub');
        const g = hexaGeo(name, down ? [1] : null);   // 내려가는 계단은 검은 판 대신 진짜 구멍
        if (!g) return;
        COLMAT = COLMAT || colMat();
        const m = new THREE.Mesh(g, COLMAT); m.position.set(cx + 0.5, 0, cz + 0.5); m.frustumCulled = false; worldGroup.add(m);
        if (down) {
            // 구멍 안쪽 벽과 바닥
            const p = [], c = [], idx = []; const q = (pts, col) => { const s0 = p.length / 3; for (const v of pts) { p.push(...v); c.push(...col); } idx.push(s0, s0 + 1, s0 + 2, s0, s0 + 2, s0 + 3); };
            const x0 = cx, x1 = cx + 1, z0 = cz, z1 = cz + 1, d = [0.1, 0.1, 0.11], e = [0.05, 0.05, 0.06];
            q([[x0, -1, z0], [x1, -1, z0], [x1, 0, z0], [x0, 0, z0]], d); q([[x0, -1, z0], [x0, -1, z1], [x0, 0, z1], [x0, 0, z0]], d);
            q([[x1, -1, z0], [x1, -1, z1], [x1, 0, z1], [x1, 0, z0]], d); q([[x0, -1, z1], [x1, -1, z1], [x1, 0, z1], [x0, 0, z1]], d);
            q([[x0, -0.6, z0], [x1, -0.6, z0], [x1, -0.6, z1], [x0, -0.6, z1]], e);
            const g2 = new THREE.BufferGeometry(); g2.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g2.setAttribute('color', new THREE.Float32BufferAttribute(c, 3)); g2.setIndex(idx);
            const m2 = new THREE.Mesh(g2, COLMAT); m2.frustumCulled = false; worldGroup.add(m2);
        }
    }
    // ---------------------------------------------------------------- 숲: 벽 대신 입체 나무(바늘잎·넓은잎 두 가지를 한꺼번에 그리기)
    function instMat(tex, alpha) {
        return new THREE.ShaderMaterial({
            uniforms: { map: { value: tex }, L: { value: LIGHTDIR } },
            vertexShader: `attribute float emit; varying vec2 vUv; varying float vL; varying float vD;
                uniform vec3 L;
                void main(){ vUv=uv;
                  #ifdef USE_INSTANCING
                    mat4 im = instanceMatrix;
                  #else
                    mat4 im = mat4(1.0);
                  #endif
                  vec3 nw=normalize(mat3(modelMatrix*im)*normal); vL=0.42+0.68*max(0.0,dot(nw,L));
                  vec4 mv=modelViewMatrix*im*vec4(position,1.0); vD=-mv.z; gl_Position=projectionMatrix*mv; }`,
            fragmentShader: `uniform sampler2D map; varying vec2 vUv; varying float vL; varying float vD;
                void main(){ vec4 t=texture2D(map,vUv); if(t.a<${alpha ? '0.3' : '0.5'}) discard;
                  float b=-7.4*min(vD,9.0)-4.0*max(vD-9.0,0.0);
                  gl_FragColor=vec4(t.rgb*vL+b/255.0,1.0); }`,
            side: THREE.DoubleSide,
        });
    }
    const treeRes = {};
    function buildTrees(trees) {
        const kinds = ['pine', 'leafy'];
        kinds.forEach((name, ki) => {
            const list = trees.filter((t) => (t[3] % 3 === 0 ? 1 : 0) === ki);
            if (!list.length) return;
            const f = FURN[name]; if (!f) return;
            if (!treeRes[name]) {
                const r = furnModel(name); if (!r) return;
                treeRes[name] = { g: r.g, m: instMat(r.m.uniforms.map.value, f.alpha) };
            }
            const im = new THREE.InstancedMesh(treeRes[name].g, treeRes[name].m, list.length);
            const o = new THREE.Object3D();
            list.forEach(([x, z, k, h], i) => {
                const sc = 1.05 + k * 0.12 + (h % 3) * 0.05;
                o.position.set(x, 0, z); o.rotation.set(0, h * 0.9, 0); o.scale.set(sc, sc * (0.95 + (h % 2) * 0.15), sc); o.updateMatrix();
                im.setMatrixAt(i, o.matrix);
            });
            im.frustumCulled = false; worldGroup.add(im);
        });
    }
    function disposeGroup(g) {
        for (const c of [...g.children]) { g.remove(c); if (c.geometry) c.geometry.dispose(); }
    }
    const CCTVB = 352, MEB = 416, CTRLB = 320, MONB = 336, EYEMON = 576, EYEWALL = 592; let animWalls = [], eyeWalls = [];
    function animateWalls() {
        const now = gv('지금'), moving = gv('나움직임') > 0;
        for (const m of animWalls) {
            const k = m.userData.anim === CCTVB ? Math.floor(now * 4) % 8 : (moving ? 1 + Math.floor(now * 4) % 2 : 0);
            const b = m.userData.anim + (m.userData.anim === CCTVB && k >= 4 ? k + 5 : k) * 16;
            m.material = matFor('w' + b, () => wallTexture(b));
        }
    }
    // 감독관이 나오면 관리실 벽·모든 화면이 눈으로
    function eyeOverride() {
        const on = gv('눈벽') === 1;
        for (const m of eyeWalls) {
            if (on) { const b = m.userData.base === CTRLB ? EYEWALL : EYEMON; m.material = matFor('w' + b, () => wallTexture(b)); }
            else if (!m.userData.anim) m.material = matFor('w' + m.userData.base, () => wallTexture(m.userData.base));
        }
    }
    function buildWorld() {
        animWalls = []; eyeWalls = [];
        disposeGroup(worldGroup); disposeGroup(lightGroup); disposeGroup(flickGroup);
        GS = LV === 6 ? 4 : 2;
        const groups = new Map();
        const G = (base) => { let g = groups.get(base); if (!g) { g = { p: [], uv: [], s: [], gl: [], c: [], idx: [] }; groups.set(base, g); } return g; };
        // 한 면을 가로로 4조각 내어 조명 번짐을 부드럽게
        function face(base, x0, z0, x1, z1, u0, u1, side, nx, nz, cid = -1) {
            const g = G(base), K = 4, start = g.p.length / 3;
            for (let k = 0; k <= K; k++) {
                const t = k / K, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t, u = u0 + (u1 - u0) * t;
                const glw = glowAt(x + nx * 0.05, z + nz * 0.05), sh = side ? -7 : 0;
                g.p.push(x, 0, z, x, 1, z); g.uv.push(u, 0, u, 1); g.s.push(sh, sh); g.gl.push(glw, glw); g.c.push(cid, cid);
            }
            for (let k = 0; k < K; k++) { const a = start + k * 2; g.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
        }
        const trees = [], stairsCells = [];
        const FOREST = 1665;
        for (let cy = 0; cy < N; cy++) for (let cx = 0; cx < N; cx++) {
            const v = M[cy * N + cx];
            if (v === -61 || v === -62) stairsCells.push([cx, cy]);
            if (LV === 5 && v === FOREST && cx > 0 && cy > 0 && cx < N - 1 && cy < N - 1) {
                // 게임 안 둥근 줄기와 같은 자리(칸마다 조금 어긋남)
                const tx = cx + 0.5 + (((cx * 7 + cy * 13) % 5) - 2) * 0.07, tz = cy + 0.5 + (((cx * 11 + cy * 3) % 5) - 2) * 0.07;
                trees.push([tx, tz, (cx * 5 + cy * 7) % 4, (cx * 13 + cy * 17) % 7]);
                continue;
            }
            if (solid(v)) {
                const base = Math.floor((v - 1) / 8);
                if (!solid(cell(cx - 1, cy))) face(base, cx, cy, cx, cy + 1, 1, 0, 0, -1, 0);           // 서쪽 면
                if (!solid(cell(cx + 1, cy))) face(base, cx + 1, cy, cx + 1, cy + 1, 0, 1, 0, 1, 0);    // 동쪽 면
                if (!solid(cell(cx, cy - 1))) face(base, cx, cy, cx + 1, cy, 0, 1, 1, 0, -1);           // 북쪽 면
                if (!solid(cell(cx, cy + 1))) face(base, cx, cy + 1, cx + 1, cy + 1, 1, 0, 1, 0, 1);    // 남쪽 면
            } else if (v > 9000) {
                const fdir = v % 100, door = Math.floor(((v > 9100 ? OPEN : DOOR) - 1) / 8), sideB = Math.floor((SIDE - 1) / 8);
                const a = 0.2, b = 0.8;
                face(fdir === 2 ? door : sideB, cx + a, cy + a, cx + a, cy + b, 1, 0, 0, -1, 0, cy * N + cx);
                face(fdir === 1 ? door : sideB, cx + b, cy + a, cx + b, cy + b, 0, 1, 0, 1, 0, cy * N + cx);
                face(fdir === 4 ? door : sideB, cx + a, cy + a, cx + b, cy + a, 0, 1, 1, 0, -1, cy * N + cx);
                face(fdir === 3 ? door : sideB, cx + a, cy + b, cx + b, cy + b, 1, 0, 1, 0, 1, cy * N + cx);
            }
        }
        for (const [base, g] of groups) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(g.p, 3));
            geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
            geo.setAttribute('shade', new THREE.Float32BufferAttribute(g.s, 1));
            geo.setAttribute('glow', new THREE.Float32BufferAttribute(g.gl, 1));
            geo.setAttribute('cid', new THREE.Float32BufferAttribute(g.c, 1));
            geo.setIndex(g.idx);
            const mesh = new THREE.Mesh(geo, matFor('w' + base, () => wallTexture(base)));
            mesh.frustumCulled = false;
            if (base === CCTVB || base === MEB) { mesh.userData.anim = base; animWalls.push(mesh); }
            if (base === CTRLB || base === MONB || base === CCTVB || base === MEB) { mesh.userData.base = base; eyeWalls.push(mesh); }
            worldGroup.add(mesh);
        }
        // 바닥·천장
        const T = window.__BR3D_TEX || {};
        const planeRect = (key, y, x0, z0, x1, z1) => {
            if (!T[key] || x1 <= x0 || z1 <= z0) return;
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute([x0, y, z0, x1, y, z0, x0, y, z1, x1, y, z1], 3));
            geo.setAttribute('uv', new THREE.Float32BufferAttribute([x0 / 2, z0 / 2, x1 / 2, z0 / 2, x0 / 2, z1 / 2, x1 / 2, z1 / 2], 2));
            geo.setAttribute('shade', new THREE.Float32BufferAttribute([0, 0, 0, 0], 1));
            geo.setAttribute('glow', new THREE.Float32BufferAttribute([0, 0, 0, 0], 1));
            geo.setAttribute('cid', new THREE.Float32BufferAttribute([-1, -1, -1, -1], 1));
            geo.setIndex([0, 2, 1, 1, 2, 3]);
            const mesh = new THREE.Mesh(geo, matFor('t' + key, () => dataTex(T[key])));
            mesh.frustumCulled = false;
            worldGroup.add(mesh);
        };
        const plane = (key, y) => {
            if (!T[key]) return;
            const geo = new THREE.BufferGeometry(), R = N / 2;
            geo.setAttribute('position', new THREE.Float32BufferAttribute([0, y, 0, N, y, 0, 0, y, N, N, y, N], 3));
            geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, R, 0, 0, R, R, R], 2));
            geo.setAttribute('shade', new THREE.Float32BufferAttribute([0, 0, 0, 0], 1));
            geo.setAttribute('glow', new THREE.Float32BufferAttribute([0, 0, 0, 0], 1));
            geo.setAttribute('cid', new THREE.Float32BufferAttribute([-1, -1, -1, -1], 1));
            geo.setIndex([0, 2, 1, 1, 2, 3]);
            const mesh = new THREE.Mesh(geo, matFor('t' + key, () => dataTex(T[key])));
            mesh.frustumCulled = false;
            worldGroup.add(mesh);
        };
        const down = stairsDown();
        const holes = down ? stairsCells : [];
        if (holes.length) {
            // 구멍 칸만 빼고 바닥을 네 조각으로
            const [hx, hz] = holes[0];
            planeRect('f' + LV, 0, 0, 0, N, hz); planeRect('f' + LV, 0, 0, hz + 1, N, N);
            planeRect('f' + LV, 0, 0, hz, hx, hz + 1); planeRect('f' + LV, 0, hx + 1, hz, N, hz + 1);
        } else plane('f' + LV, 0);
        for (const [cx, cz] of stairsCells) buildStairs(cx, cz, down);
        if (trees.length) buildTrees(trees);
        if (LV !== 5 && LV !== 8) plane('c' + LV, 1);   // 숲·놀이동산은 하늘이 열려 있다
        // 조명: 천장 등판 + 바닥 빛 웅덩이
        if (LIT[LV]) {
            const lp = obj('조명') ? obj('조명').pictures : null;
            if (lp) {
                const kind = LIT[LV];
                const gkey = (LV === 2 || LV === 9) ? 'glow_lab' : LV === 7 ? 'glow_sub' : 'glow_br';
                const quads = { panel: [], glow: [], fpanel: [], fglow: [] };
                hangs = [];
                for (let by = 0; by * GS < N; by++) for (let bx = 0; bx * GS < N; bx++) {
                    const L = lpick(bx, by);
                    if (!L) continue;
                    const fl = L[2] === 4;
                    if (kind === 'hang') hangs.push(L); else (fl ? quads.fpanel : quads.panel).push([L[0], L[1], 0.8, 0.995]);
                    (fl ? quads.fglow : quads.glow).push([L[0], L[1], 1.6, 0.004]);
                }
                const mk = (arr, picIdx, grp) => {
                    if (!arr.length || !lp[picIdx]) return;
                    const p = [], uv = [], idx = [];
                    arr.forEach(([x, z, h, y], i) => {
                        p.push(x - h, y, z - h, x + h, y, z - h, x - h, y, z + h, x + h, y, z + h);
                        uv.push(0, 1, 1, 1, 0, 0, 1, 0);
                        const a = i * 4; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
                    });
                    const geo = new THREE.BufferGeometry();
                    geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
                    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
                    geo.setIndex(idx);
                    const url = imgSrc(lp[picIdx]);
                    const mat = makeDecalMat(texFromUrlForce(url));
                    const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = 1;
                    grp.add(mesh);
                };
                if (kind !== 'hang') {
                    // 천장 등: 납작한 그림 대신 테두리가 있는 입체 등(게임 안과 같은 모양)
                    const nm = (LV === 2 || LV === 9) ? 'light_lab' : LV === 7 ? 'light_sub' : 'light_br';
                    const g0 = hexaGeo(nm), g1 = hexaGeo(LV === 7 ? 'light_suboff' : 'light_off');
                    const put = (arr, g, grp) => {
                        if (!g || !arr.length) return;
                        const P = g.getAttribute('position').array, Cc = g.getAttribute('color').array, I = g.index.array;
                        const p = [], c = [], idx = [];
                        arr.forEach(([x, z], k) => {
                            const base = p.length / 3;
                            for (let i = 0; i < P.length; i += 3) p.push(P[i] + x, P[i + 1], P[i + 2] + z);
                            for (let i = 0; i < Cc.length; i++) c.push(Cc[i]);
                            for (let i = 0; i < I.length; i++) idx.push(I[i] + base);
                        });
                        const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); gg.setAttribute('color', new THREE.Float32BufferAttribute(c, 3)); gg.setIndex(idx);
                        COLMAT = COLMAT || colMat();
                        const m = new THREE.Mesh(gg, COLMAT); m.frustumCulled = false; grp.add(m);
                    };
                    put(quads.panel, g0, lightGroup); put(quads.fpanel, g0, flickGroup);
                }
                mk(quads.glow, LT_IDX[gkey], lightGroup); mk(quads.fglow, LT_IDX[gkey], flickGroup);
            }
        } else hangs = [];
        buildFurn();
        // 하늘(숲)
        if (skyMesh) { scene.remove(skyMesh); skyMesh = null; }
        if ((LV === 5 || LV === 8) && obj('하늘')) {
            const url = imgSrc(obj('하늘').pictures[LV === 8 && obj('하늘').pictures[1] ? 1 : 0]);
            const R = 30, Hpx = 190;
            const geo = new THREE.CylinderGeometry(R, R, Hpx * R / P, 64, 1, true);
            const mat = new THREE.ShaderMaterial({
                uniforms: { map: { value: texFromUrlForce(url) } },
                vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
                fragmentShader: `uniform sampler2D map; varying vec2 vUv; void main(){ gl_FragColor=texture2D(map,vUv); }`,
                side: THREE.DoubleSide, depthWrite: false,
            });
            skyMesh = new THREE.Mesh(geo, mat); skyMesh.frustumCulled = false; skyMesh.renderOrder = -1;
            scene.add(skyMesh);
        }
    }
    let hangs = [];
    // ---------------------------------------------------------------- 가구: 진짜 3D 모델(furn.js)
    const FURN = window.__BR3D_FURN || {};
    const furnRes = {};
    const LIGHTDIR = new THREE.Vector3(-0.45, 0.8, 0.55).normalize();
    function furnMat(tex, alpha) {
        return new THREE.ShaderMaterial({
            uniforms: { map: { value: tex }, L: { value: LIGHTDIR }, glowOn: { value: 1 }, bright: { value: 0 } },
            vertexShader: `attribute float emit; varying vec2 vUv; varying float vL; varying float vD; varying float vE;
                uniform vec3 L;
                void main(){ vUv=uv; vE=emit; vec3 nw=normalize(mat3(modelMatrix)*normal); vL=0.42+0.68*max(0.0,dot(nw,L));
                  vec4 mv=modelViewMatrix*vec4(position,1.0); vD=-mv.z; gl_Position=projectionMatrix*mv; }`,
            fragmentShader: `uniform sampler2D map; uniform float bright; varying vec2 vUv; varying float vL; varying float vD; varying float vE;
                void main(){ vec4 t=texture2D(map,vUv); if(t.a<${alpha ? '0.3' : '0.5'}) discard;
                  vec3 c = vE>0.5 ? t.rgb*1.12 : t.rgb*vL;
                  float b=-7.4*min(vD,9.0)-4.0*max(vD-9.0,0.0)+bright;
                  if(vE>0.5) b*=0.35;
                  gl_FragColor=vec4(c+b/255.0,1.0); }`,
            side: THREE.DoubleSide,
        });
    }
    function furnModel(name) {
        if (furnRes[name] !== undefined) return furnRes[name];
        const f = FURN[name];
        if (!f) { furnRes[name] = null; return null; }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(f.p, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(f.n, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(f.uv, 2));
        g.setAttribute('emit', new THREE.Float32BufferAttribute(f.e, 1));
        const im = new Image(); const tex = new THREE.Texture(im);
        tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
        im.onload = () => { tex.needsUpdate = true; }; im.src = f.img;
        furnRes[name] = { g, m: furnMat(tex, f.alpha) };
        return furnRes[name];
    }
    let shadowTex = null;
    function blobShadow() {
        if (!shadowTex) {
            const c = document.createElement('canvas'); c.width = c.height = 64;
            const x = c.getContext('2d'); const gr = x.createRadialGradient(32, 32, 2, 32, 32, 31);
            gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
            shadowTex = new THREE.CanvasTexture(c);
        }
        const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
        m.rotation.x = -Math.PI / 2; m.position.y = 0.006; m.renderOrder = 1; m.frustumCulled = false;
        return m;
    }
    const NO_SHADOW = { 6: 1, 17: 1, 23: 1, 25: 1, 26: 1 };
    function buildFurn() {
        disposeGroup(furnGroup); furnList = [];
        const T = list('가구T'), X = list('가구X'), Y = list('가구Y'), R = list('가구R'), LAY = list('조각배치');
        if (!T || !X || !Y || !LAY) return;
        const Ta = T.getArray(), Xa = X.getArray(), Ya = Y.getArray(), Ra = R ? R.getArray() : [], La = LAY.getArray();
        const GRID = Math.round(Math.sqrt(La.length)) || 7, CH = N / GRID, NCH = 12;
        const num = (a, i) => Number(a[i] ? a[i].data : 0) || 0;
        for (let pcy = 0; pcy < GRID; pcy++) for (let pcx = 0; pcx < GRID; pcx++) {
            const d = num(La, pcy * GRID + pcx);
            if (!d) continue;
            for (let k = 0; k < 8; k++) {
                const li = (LV - 1) * NCH * 8 + (d - 1) * 8 + k;
                const t = num(Ta, li);
                if (!t) continue;
                const f = { t, x: pcx * CH + num(Xa, li), z: pcy * CH + num(Ya, li), r: num(Ra, li), name: '', root: new THREE.Group(), pivot: new THREE.Group(), mesh: null, shadow: null };
                f.root.position.set(f.x, 0, f.z);
                const fx = Math.cos(f.r * Math.PI / 2), fz = Math.sin(f.r * Math.PI / 2);
                f.root.rotation.y = Math.atan2(fx, fz);
                f.root.add(f.pivot);
                if (t === 32 && obj('조명') && obj('조명').pictures[LT_IDX.glow_br]) {
                    const gm = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), makeDecalMat(texFromUrlForce(imgSrc(obj('조명').pictures[LT_IDX.glow_br]))));
                    gm.rotation.x = -Math.PI / 2; gm.position.y = 0.005; gm.renderOrder = 1; gm.frustumCulled = false; f.root.add(gm);
                }
                if (!NO_SHADOW[t]) { f.shadow = blobShadow(); const sz = t >= 14 && t <= 16 ? 0.7 : 0.95; f.shadow.scale.set(sz, sz, 1); f.root.add(f.shadow); }
                f.root.visible = false;
                furnGroup.add(f.root); furnList.push(f);
            }
        }
    }
    window.__br3dFurn = () => furnList.map((f) => [f.t, f.x, f.z, f.r, f.name]);   // 점검용
    let signMesh = null;
    function furnName(f) {
        const t = f.t, c = cell(Math.floor(f.x), Math.floor(f.z));
        switch (t) {
            case 1: return 'desk'; case 2: return 'chair'; case 3: return 'plant'; case 4: case 5: return 'shelf'; case 6: return 'lamp';
            case 7: { const base = LV === 5 ? 'chest' : LV >= 6 ? 'tool' : 'dresser'; return base + (c === -10 ? '1' : '0'); }
            case 8: { const k = -20 - c; return 'stand' + (k >= 1 && k <= 6 ? k : 0); }
            case 9: return 'counter'; case 10: return 'bed'; case 11: return 'sofa'; case 12: return (c === -113 && Math.random() > 0.25) ? 'tv0' : 'tv1';
            case 13: return 'bush'; case 14: return 'pine'; case 15: return 'leafy'; case 16: return 'dead';
            case 17: return 'web'; case 18: return 'boxes'; case 19: return 'barrel'; case 20: return 'crate';
            case 22: return 'bench'; case 23: return 'sign'; case 24: return 'gate'; case 25: return 'vent';
            case 26: return Math.floor(gv('지금') * 3) % 2 ? 'venth1' : 'venth0';
            case 27: return 'carousel'; case 28: return 'teacup'; case 29: return 'bumper'; case 30: return 'popcorn';
            case 31: return 'balloons'; case 32: return 'lamppost'; case 33: return 'booth';
            case 34: return 'door'; case 36: return 'notestand'; case 37: return 'rack'; case 38: return 'console';
        }
        return '';
    }
    function signTexIdx() {
        const st = gv('열차상태');
        return st >= 1 && st <= 3 ? (gv('열차괴물') === 1 ? 39 : 38) : 37;
    }
    // 가구 크기: 눈높이(0.5)에 맞춘 실제 비율로 줄임
    const FSCALE = {"desk": 0.551, "chair": 0.545, "dresser0": 0.57, "dresser1": 0.57, "chest0": 0.606, "chest1": 0.603, "tool0": 0.583, "tool1": 0.583, "counter": 0.602, "bed": 0.552, "sofa": 0.548, "tv0": 0.56, "tv1": 0.56, "boxes": 0.553, "crate": 0.557, "bench": 0.549, "gate": 0.642, "plant": 0.756, "shelf": 0.618, "lamp": 1, "barrel": 0.633, "pine": 1, "leafy": 1, "dead": 1, "bush": 0.89, "stand0": 0.559, "stand1": 0.559, "stand2": 0.559, "stand3": 0.559, "stand4": 0.559, "stand5": 0.559, "stand6": 0.559, "carousel": 1.15, "teacup": 0.963, "bumper": 0.655, "popcorn": 0.666, "balloons": 0.805, "lamppost": 1.5, "booth": 0.95};
    function updateFurn(c) {
        const now = gv('지금');
        for (const f of furnList) {
            const dx = f.x - c.ex, dz = f.z - c.ez;
            const near = dx * dx + dz * dz < 196 && (dx * c.dX + dz * c.dY) > -1.5 && !(gv('숨음') !== 0 && dx * dx + dz * dz < 0.5);   // 숨어 있는 가구 안에서는 그 가구를 그리지 않는다
            f.root.visible = near;
            if (!near) continue;
            const name = furnName(f);
            if (name !== f.name) {
                f.name = name;
                if (f.mesh) { f.pivot.remove(f.mesh); f.mesh = null; }
                if (name === 'sign') {
                    const pics = obj('가구') && obj('가구').pictures;
                    const mat = new THREE.ShaderMaterial({
                        uniforms: { map: { value: null } },
                        vertexShader: `varying vec2 vUv; varying float vD; void main(){ vUv=uv; vec4 mv=modelViewMatrix*vec4(position,1.0); vD=-mv.z; gl_Position=projectionMatrix*mv; }`,
                        fragmentShader: `uniform sampler2D map; varying vec2 vUv; varying float vD; void main(){ vec4 t=texture2D(map,vUv); if(t.a<0.4) discard; gl_FragColor=vec4(t.rgb-2.5*min(vD,9.0)/255.0,1.0); }`,
                        side: THREE.DoubleSide,
                    });
                    f.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.27), mat);
                    f.mesh.position.y = 0.865; f.signPics = pics; f.signIdx = -1;
                } else {
                    const r = furnModel(name);
                    if (r) f.mesh = new THREE.Mesh(r.g, r.m);
                    else if (F3 && F3.names.includes(name)) { COLMAT = COLMAT || colMat(); f.mesh = new THREE.Mesh(hexaGeo(name), COLMAT); }
                    if (f.t === 34 && !f.frame) { COLMAT = COLMAT || colMat(); f.frame = new THREE.Mesh(hexaGeo('doorframe'), COLMAT); f.frame.frustumCulled = false; f.root.add(f.frame); }
                }
                if (f.mesh) {
                    f.sc = FSCALE[name] || 1; f.mesh.scale.setScalar(f.sc); f.mesh.frustumCulled = false; f.pivot.add(f.mesh);
                    if (f.shadow && !(f.t >= 13 && f.t <= 16)) f.shadow.scale.set(0.95 * f.sc, 0.95 * f.sc, 1);
                }
            }
            if (!f.mesh) continue;
            if (name === 'sign' && f.signPics) {
                const idx = signTexIdx();
                if (idx !== f.signIdx) { const u = imgSrc(f.signPics[idx]); const tx = u && texFromUrl(u); if (tx) { f.mesh.material.uniforms.map.value = tx; f.signIdx = idx; } }
                f.mesh.visible = !!f.mesh.material.uniforms.map.value;
            }
            // 책장: 흔들리다 앞으로 쓰러짐(앞 아래 모서리가 축)
            if (f.t === 4 || f.t === 5) {
                const cv = cell(Math.floor(f.x), Math.floor(f.z));
                let ang = 0;
                if (cv === -8) ang = 90;
                else if (cv === -7) {
                    const el = now - gv('책장시각');
                    ang = el < 0.8 ? Math.sin(el * 1400 * Math.PI / 180) * 4 : Math.min(88, (el - 0.8) * 260);
                }
                const pz = 0.17 * (f.sc || 1); f.pivot.position.set(0, 0, pz); f.mesh.position.set(0, 0, -pz);
                f.pivot.rotation.x = ang * Math.PI / 180;
            }
            if (f.t === 34) {
                const cx = Math.floor(f.x), cz = Math.floor(f.z), cv = cell(cx, cz), idx = cz * N + cx + 1;
                let pr = (cv === -72 || cv === -73) ? 1 : 0;
                if (gv('문열림칸') === idx) { pr = Math.min(1, (gv('지금') - gv('문열림시각')) / 0.6); pr = pr * pr * (3 - 2 * pr); }
                f.root.rotation.y = f.r === 0 ? 0 : -Math.PI / 2;
                f.pivot.position.set(-0.48, 0, 0); f.mesh.position.set(0, 0, 0);
                f.pivot.rotation.y = -pr * Math.PI / 2;
                f.sc = 1; f.mesh.scale.setScalar(1);
            }
            // 회전목마는 돌고, 커피잔은 천천히 돈다
            if (f.t === 27) f.pivot.rotation.y = now * 1.1;
            if (f.t === 28) f.pivot.rotation.y = now * 0.35 + f.x;
            // 천장 등: 천장에 매달려 살짝 흔들림
            if (f.t === 6) {
                f.pivot.position.set(0, 1, 0); f.mesh.position.set(0, -1, 0);
                f.pivot.rotation.z = Math.sin((now * 80 + f.x * 37) * Math.PI / 180) * 5 * Math.PI / 180;
            }
        }
    }
    const matCache = new Map();
    function matFor(key, texFn) {
        let m = matCache.get(key);
        if (!m) { m = makeWorldMat(texFn()); matCache.set(key, m); }
        return m;
    }
    function dataTex(src) {
        const im = new Image(); const tex = new THREE.Texture(im);
        im.onload = () => { tex.needsUpdate = true; };
        im.src = src;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.anisotropy = 4;
        return tex;
    }
    function texFromUrlForce(url) {
        const r = loadImg(url); const tex = new THREE.Texture(r.im);
        tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
        const poll = () => { if (r.ok) tex.needsUpdate = true; else setTimeout(poll, 60); };
        poll();
        return tex;
    }

    // ---------------------------------------------------------------- 매 프레임
    const pool = []; let used = 0;
    function bill() {
        let m = pool[used];
        if (!m) { m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), billMat()); m.frustumCulled = false; pool.push(m); sceneB.add(m); }
        used++; m.visible = true; return m;
    }
    function setCams(c) {
        const { ex, ez, eyeH, dX, dY, sy, sX, sY } = c;
        const rX = dY, rY = -dX;
        const view = new THREE.Matrix4().set(
            rX, 0, rY, -(ex * rX + ez * rY),
            0, 1, 0, -eyeH,
            -dX, 0, -dY, ex * dX + ez * dY,
            0, 0, 0, 1);
        camW.matrixWorldInverse.copy(view);
        camW.matrix.copy(view).invert(); camW.matrixWorld.copy(camW.matrix);
        const proj = new THREE.Matrix4().set(
            1 / sy, 0, -sX / 240, 0,
            0, P / 135, -sY / 135, 0,
            0, 0, -(FAR + NEAR) / (FAR - NEAR), -2 * FAR * NEAR / (FAR - NEAR),
            0, 0, -1, 0);
        for (const cam of [camW, camB]) { cam.projectionMatrix.copy(proj); cam.projectionMatrixInverse.copy(proj).invert(); }
        camB.matrix.identity(); camB.matrixWorld.identity(); camB.matrixWorldInverse.identity();
        if (skyMesh) { skyMesh.position.set(ex, eyeH + 95 * 30 / P, ez); skyMesh.rotation.y = 0; }
        return view;
    }
    function render3D() {
        if (!attach()) return;
        syncSize();
        frame++;
        if (frame % 15 === 1 || !M) {
            LV = gv('단계', 1);
            const r = readMap();
            if (r.sig !== mapSig) { M = r.m; mapSig = r.sig; try { buildWorld(); } catch (e) { window.__br3dErr = String(e && e.stack || e); console.warn('[백룸 3D 도우미] 세계 만들기', e); } }
        }
        const c = {
            ex: gv('posX'), ez: gv('posY'), dX: gv('dirX', 1), dY: gv('dirY'), sy: gv('시야', 0.66) || 0.66,
            sX: gv('화면X'), sY: gv('화면Y'),
        };
        c.eyeH = 0.5 - 0.3 * gv('앉음');
        const view = setCams(c);
        updateFurn(c); if (animWalls.length) animateWalls(); if (eyeWalls.length) eyeOverride();
        const outage = gv('정전') === 1;
        const hiding = gv('숨음') !== 0, hc = hiding ? Math.floor(c.ez) * N + Math.floor(c.ex) : -9;
        for (const m of worldMats) { m.uniforms.glowOn.value = outage ? 0 : 1; m.uniforms.hideCell.value = hc; }
        lightGroup.visible = !outage; flickGroup.visible = !outage;
        const dim = Math.random() < 1 / 7 ? 0.3 : 1;
        for (const m of flickGroup.children) if (m.material.uniforms && m.material.uniforms.dim) m.material.uniforms.dim.value = dim;
        // 괴물·가구·열차: 엔트리가 계산한 화면 위치와 깊이로 3D 공간에 판을 세운다
        used = 0;
        for (const name in BILL) {
            const o = obj(name);
            if (!o) continue;
            const ents = o.clonedEntities || [];
            for (const e of ents) {
                if (!e.visible) continue;
                const f = localVar(e, '깊이');
                if (!(f > 0.05)) continue;
                const pic = e.picture; const url = imgSrc(pic);
                if (!url) continue;
                const tex = texFromUrl(url);
                if (!tex) continue;
                const sxv = e.getScaleX ? e.getScaleX() : e.scaleX, syv = e.getScaleY ? e.getScaleY() : e.scaleY;
                const ws = e.getWidth() * Math.abs(sxv), hs = e.getHeight() * Math.abs(syv);
                const fp = Math.max(0.12, f - BILL[name]), k = fp / f;
                const m = bill();
                m.position.set((e.getX() - c.sX) * f * c.sy / 240 * k, (e.getY() - c.sY) * f / P * k, -fp);
                m.scale.set(ws * f * c.sy / 240 * k, hs * f / P * k, 1);
                m.rotation.set(0, 0, -(e.getRotation ? e.getRotation() : e.rotation || 0) * Math.PI / 180);
                const u = m.material.uniforms;
                u.map.value = tex;
                u.add.value = ((e.effect && e.effect.brightness) || 0) / 255;
                u.alpha.value = e.effect && e.effect.alpha !== undefined ? e.effect.alpha : 1;
                u.flipX.value = sxv < 0 ? 1 : 0;
                m.renderOrder = 10;
            }
        }
        // 창고의 매달린 갓등(정면 판)
        if (hangs.length && !outage && obj('조명')) {
            const url = imgSrc(obj('조명').pictures[LT_IDX.hang]); const tex = url && texFromUrl(url);
            if (tex) for (const L of hangs) {
                const v = new THREE.Vector3(L[0], 0.69, L[1]).applyMatrix4(view);
                if (-v.z < 0.3 || -v.z > 16) continue;
                const m = bill();
                m.position.copy(v); m.scale.set(0.62 * 96 / 160, 0.62, 1); m.rotation.set(0, 0, 0);
                const u = m.material.uniforms; u.map.value = tex; u.add.value = Math.max(-0.35, -7 * (-v.z) / 255); u.alpha.value = 1; u.flipX.value = 0;
            }
        }
        for (let i = used; i < pool.length; i++) pool[i].visible = false;
        renderer.clear(true, true, true);
        renderer.render(scene, camW);
        renderer.render(sceneB, camB);
    }

    // ---------------------------------------------------------------- 엔트리 그리기에 끼어들기
    let hiddenObjs = [];
    function hideWorld() {
        hiddenObjs.length = 0;
        for (const n of WORLD) {
            const o = obj(n);
            if (!o) continue;
            const ents = [o.entity, ...(o.clonedEntities || [])];
            for (const e of ents) if (e && e.object && e.object.visible) { e.object.visible = false; hiddenObjs.push(e.object); }
        }
        const bg = Entry.stage.background;
        if (bg && bg.visible) { bg.visible = false; hiddenObjs.push(bg); }
    }
    function restoreWorld() { for (const o of hiddenObjs) o.visible = true; hiddenObjs.length = 0; }
    function shouldRun() {
        if (!want3d || !isGame()) return false;
        const s = gv('상태');
        return s !== 0 && s !== 6;
    }
    function hook() {
        const st = Entry.stage;
        if (st.__br3dHooked) return;
        st.__br3dHooked = true;
        const orig = st.updateForce.bind(st);
        st.updateForce = function () {
            let hid = false;
            try {
                if (frame % 120 === 0) { VC = {}; LC = {}; OC = {}; }
                if (isGame()) sv('확장3D', want3d ? 1 : 0);   // 작품 설정에서 그래픽 줄을 숨긴다
                const run = shouldRun();
                if (run !== active) {
                    active = run; sv('완전3D', run ? 1 : 0);
                    if (glc) glc.style.display = run ? 'block' : 'none';
                    if (entryCanvas) {
                        if (run) { if (entryCanvas.__br3dBg === undefined) entryCanvas.__br3dBg = entryCanvas.style.backgroundColor; entryCanvas.style.backgroundColor = 'transparent'; }
                        else if (entryCanvas.__br3dBg !== undefined) { entryCanvas.style.backgroundColor = entryCanvas.__br3dBg; delete entryCanvas.__br3dBg; }
                    }
                    if (!run) { mapSig = ''; M = null; sv('지도변함', 1); }   // 2D로 돌아가면 벽을 다시 그리게
                }
                if (!run && !want3d) sv('완전3D', 0);
                if (run) { if (!gl) setup(); render3D(); if (glc.style.display !== 'block') glc.style.display = 'block'; hideWorld(); hid = true; }
                else { frame++; if (!entryCanvas && gl) attach(); }
            } catch (err) { console.warn('[백룸 3D 도우미]', err); }
            try { return orig.apply(this, arguments); } finally { if (hid) restoreWorld(); }
        };
    }
    function boot() {
        if (window.Entry && Entry.stage && Entry.stage.updateForce && Entry.variableContainer && Entry.container) {
            hook();
        }
        setTimeout(boot, 1000);   // 작품을 다시 불러와도 다시 연결
    }
    boot();
})();
