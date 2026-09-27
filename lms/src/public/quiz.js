(function () {
  var timer = document.getElementById('timer');
  var form = document.getElementById('quiz-form');
  if (!timer || !form) return;
  var deadline = new Date(timer.dataset.deadline).getTime();
  function tick() {
    var left = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
    var m = Math.floor(left / 60);
    var s = left % 60;
    timer.textContent = m + ':' + (s < 10 ? '0' : '') + s;
    timer.classList.toggle('urgent', left <= 60);
    if (left <= 0) {
      clearInterval(iv);
      timer.textContent = 'Tempo esgotado — enviando...';
      form.submit();
    }
  }
  var iv = setInterval(tick, 1000);
  tick();
})();
