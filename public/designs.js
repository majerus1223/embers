// Flame design picker. The choice is per-browser (localStorage) and read by
// flames.js on the home page; faro-init.js reports it as the flame-design
// feature flag so the RUM plugin's Flags page can slice sessions by design.
(function () {
  var KEY = 'embers:design';

  function current() {
    try { return window.localStorage.getItem(KEY) || 'classic'; } catch (e) { return 'classic'; }
  }

  function markSelected(design) {
    document.querySelectorAll('.design-card').forEach(function (card) {
      card.classList.toggle('selected', card.dataset.design === design);
    });
    document.getElementById('selectedNote').textContent =
      'Current design: ' + design;
  }

  document.getElementById('designs').addEventListener('click', function (ev) {
    var card = ev.target.closest('.design-card');
    if (!card) return;
    var design = card.dataset.design;
    try { window.localStorage.setItem(KEY, design); } catch (e) {}
    window.EMBERS_DESIGN = design;
    markSelected(design);

    // Custom RUM event: shows up on the session timeline and in Explorer.
    if (window.faro) {
      window.faro.api.pushEvent('design_changed', { design: design });
    }
  });

  markSelected(current());
})();
