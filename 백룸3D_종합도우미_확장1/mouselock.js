// 백룸 3D 종합 도우미 — 마우스 고정 + 마우스 휠(설정 창 스크롤 / 아이템 칸 이동)
// 작품에 '잠금허용' 변수가 있을 때만 동작합니다(다른 작품에는 영향 없음).
(() => {
    if (window.__entryMouseLock) return;
    window.__entryMouseLock = true;
    const lockOn = () => document.documentElement.dataset.brlock !== '0';
    let accX = 0, accY = 0, wasLocked = false;
    const V = (n) => {
        try { return window.Entry && Entry.variableContainer ? Entry.variableContainer.getVariableByName(n) : null; } catch (_) { return null; }
    };
    const num = (n, d = 0) => { const v = V(n); const x = v ? Number(v.getValue()) : NaN; return isNaN(x) ? d : x; };
    const canvas = () => document.getElementById('entryCanvas') || (window.Entry && Entry.stage && ((Entry.stage._app && Entry.stage._app.view) || (Entry.stage.canvas && Entry.stage.canvas.canvas))) || null;
    const running = () => !!(window.Entry && Entry.engine && Entry.engine.state === 'run');
    const supported = () => !!V('잠금허용');
    const allowed = () => num('잠금허용') === 1;
    const set = (n, val) => { const v = V(n); if (v && v.getValue() != val) v.setValue(val); };
    // 화면을 누르면 고정(브라우저 규칙상 클릭할 때만 고정할 수 있음)
    document.addEventListener('mousedown', (e) => {
        if (!lockOn() || !running() || !supported() || !allowed()) return;
        const c = canvas();
        if (!c || e.target !== c || document.pointerLockElement === c) return;
        try { const r = c.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (_) { /* 무시 */ }
    }, true);
    document.addEventListener('mousemove', (e) => {
        const c = canvas();
        if (c && document.pointerLockElement === c) { accX += e.movementX || 0; accY += e.movementY || 0; }
    }, true);
    // 마우스 휠: 설정 창이 열려 있으면 목록 스크롤, 아니면 아이템 칸 이동('휠로 아이템 고르기'가 켜져 있을 때)
    let wheelAcc = 0, wheelCount = 0;
    document.addEventListener('wheel', (e) => {
        if (!supported()) return;
        const c = canvas();
        const onCanvas = c && (e.target === c || document.pointerLockElement === c);
        if (!onCanvas) return;
        let d = e.deltaY;
        if (e.deltaMode === 1) d *= 16; else if (e.deltaMode === 2) d *= 200;
        if (num('메뉴') === 1 && V('스크롤목표')) {
            const v = V('스크롤목표');
            v.setValue(Math.max(0, Math.min(num('스크롤최대', 9999), Number(v.getValue()) + d * 0.45)));
            e.preventDefault();
            return;
        }
        if (!running() || num('휠선택') !== 1) return;
        e.preventDefault();
        wheelAcc += d;
        while (wheelAcc >= 50) { wheelCount += 1; wheelAcc -= 100; }
        while (wheelAcc <= -50) { wheelCount -= 1; wheelAcc += 100; }
        set('휠누적', wheelCount);
    }, { capture: true, passive: false });
    // ESC로 고정이 풀리면 작품의 설정 창을 연다
    document.addEventListener('pointerlockchange', () => {
        const c = canvas();
        const locked = !!c && document.pointerLockElement === c;
        if (wasLocked && !locked && running() && supported() && allowed()) set('메뉴요청', 1);
        wasLocked = locked;
    });
    const loop = () => {
        if (running() && supported()) {
            const c = canvas();
            const locked = !!c && document.pointerLockElement === c;
            set('확장연결', lockOn() ? (locked ? 2 : 1) : 0);
            set('마우스누적X', accX);
            set('마우스누적Y', accY);
            if (locked && (!lockOn() || !allowed())) document.exitPointerLock();
        } else if (document.pointerLockElement && document.pointerLockElement === canvas()) {
            document.exitPointerLock();
        }
        requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
})();
