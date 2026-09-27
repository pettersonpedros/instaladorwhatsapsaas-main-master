(function () {
  // confirmações
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-confirm]');
    if (el && !window.confirm(el.getAttribute('data-confirm'))) e.preventDefault();
    var back = e.target.closest('[data-back]');
    if (back && history.length > 1) { e.preventDefault(); history.back(); }
    if (e.target.closest('[data-print]')) window.print();
  });

  // mostra/esconde blocos conforme um select; campos ocultos ficam desabilitados para não serem enviados
  function bindToggle(select, attr) {
    if (!select) return;
    var form = select.form || document;
    function update() {
      form.querySelectorAll('[' + attr + ']').forEach(function (block) {
        var show = block.getAttribute(attr).split(' ').indexOf(select.value) >= 0;
        block.classList.toggle('hidden', !show);
        block.querySelectorAll('input, select, textarea').forEach(function (i) { i.disabled = !show; });
        if (block.matches('input, select, textarea')) block.disabled = !show;
      });
    }
    select.addEventListener('change', update);
    update();
  }
  bindToggle(document.querySelector('[data-event-select]'), 'data-show-event');
  bindToggle(document.querySelector('[data-action-select]'), 'data-show-action');
  bindToggle(document.querySelector('[data-kind-select]'), 'data-kind');

  var toSelect = document.querySelector('[data-to-select]');
  var toValue = document.querySelector('[data-to-value]');
  if (toSelect && toValue) {
    var syncTo = function () { toValue.classList.toggle('hidden', toSelect.value !== 'custom'); };
    toSelect.addEventListener('change', syncTo);
    syncTo();
  }

  document.querySelectorAll('[data-role-select]').forEach(function (sel) {
    var perms = sel.form.querySelector('[data-perms]');
    var sync = function () { if (perms) perms.classList.toggle('hidden', sel.value !== 'staff'); };
    sel.addEventListener('change', sync);
    sync();
  });

  // inserir variáveis {{...}} no último campo de texto focado
  var lastField = null;
  document.addEventListener('focusin', function (e) {
    if (e.target.matches('.trigger-form textarea, .trigger-form input[type=text], .trigger-form input:not([type])')) lastField = e.target;
  });
  document.querySelectorAll('[data-insert-var]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var field = lastField || document.querySelector('.trigger-form textarea[name=message]');
      if (!field) return;
      var v = btn.getAttribute('data-insert-var');
      var s = field.selectionStart || field.value.length;
      field.value = field.value.slice(0, s) + v + field.value.slice(field.selectionEnd || s);
      field.focus();
      field.selectionStart = field.selectionEnd = s + v.length;
    });
  });
})();
