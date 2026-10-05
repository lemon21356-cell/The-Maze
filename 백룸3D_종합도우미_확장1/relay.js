// 확장 설정(chrome.storage) → 페이지(엔트리)로 전달. Alt+3: 완전 3D 켜고 끄기
(function () {
    const D = { br3d_on: true, enabled: true };   // enabled = 마우스 고정(예전 확장과 같은 이름)
    function apply(o) {
        const ds = document.documentElement.dataset;
        ds.br3d = o.br3d_on ? '1' : '0';
        ds.brlock = o.enabled ? '1' : '0';
        document.dispatchEvent(new Event('br3d-setting'));
    }
    function toast(msg) {
        if (window !== window.top) return;
        let t = document.getElementById('br3dToast');
        if (!t) {
            t = document.createElement('div'); t.id = 'br3dToast';
            t.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483647;padding:8px 16px;border-radius:999px;' +
                'background:rgba(20,18,12,.88);color:#f5e7b0;font:600 14px/1.2 system-ui,sans-serif;border:1px solid #8a7440;pointer-events:none;transition:opacity .3s';
            (document.body || document.documentElement).appendChild(t);
        }
        t.textContent = msg; t.style.opacity = '1';
        clearTimeout(t.__h); t.__h = setTimeout(() => { t.style.opacity = '0'; }, 1400);
    }
    const load = () => chrome.storage.local.get(D, apply);
    load();
    window.addEventListener('DOMContentLoaded', load);
    chrome.storage.onChanged.addListener((c, area) => {
        if (area !== 'local') return;
        load();
        if (c.br3d_on) toast(c.br3d_on.newValue ? '완전 3D 켬' : '완전 3D 끔');
        if (c.enabled) toast(c.enabled.newValue ? '마우스 고정 켬' : '마우스 고정 끔');
    });
    window.addEventListener('keydown', (e) => {
        if (e.altKey && e.code === 'Digit3') {
            e.preventDefault(); e.stopImmediatePropagation();   // 게임에는 3 키가 가지 않게
            chrome.storage.local.get(D, (o) => chrome.storage.local.set({ br3d_on: !o.br3d_on }));
        }
    }, true);
})();
