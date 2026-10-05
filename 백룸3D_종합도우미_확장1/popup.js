const D = { br3d_on: true, enabled: true };
chrome.storage.local.get(D, (o) => {
    for (const k of Object.keys(D)) {
        const box = document.getElementById(k);
        box.checked = !!o[k];
        box.addEventListener('change', () => chrome.storage.local.set({ [k]: box.checked }));
    }
});
