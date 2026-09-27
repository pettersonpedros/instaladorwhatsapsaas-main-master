(function () {
  var el = document.getElementById('player');
  if (!el) return;
  var csrf = document.querySelector('meta[name=csrf-token]').content;
  var lessonId = el.dataset.lesson;
  var preventSkip = el.dataset.preventSkip === '1';
  var maxWatched = parseFloat(el.dataset.maxWatched) || 0;
  var completed = el.dataset.completed === '1';
  var threshold = parseInt(el.dataset.threshold, 10);
  var bar = document.getElementById('watch-bar');
  var text = document.getElementById('watch-text');
  var nextBtn = document.getElementById('next-btn');

  var player = null;
  var segments = [];     // segmentos fechados ainda não enviados
  var segStart = null;   // início do segmento atual
  var lastTime = null;
  var lastWall = 0;
  var dirty = false;
  var sampler = null;

  function closeSegment() {
    if (segStart !== null && lastTime !== null && lastTime > segStart) segments.push([segStart, lastTime]);
    segStart = null;
  }

  function sample() {
    if (!player || typeof player.getCurrentTime !== 'function') return;
    var t = player.getCurrentTime();
    var rate = player.getPlaybackRate ? player.getPlaybackRate() : 1;
    var now = Date.now();
    // compara com o tempo real decorrido (abas em segundo plano recebem timers atrasados)
    var wall = (now - lastWall) / 1000;
    var contiguous = lastTime !== null && t >= lastTime && t - lastTime <= wall * rate + 1.5;
    lastWall = now;
    if (!contiguous) {
      closeSegment();
      if (preventSkip && t > maxWatched + 3) {
        player.seekTo(maxWatched, true);
        t = maxWatched;
      }
      segStart = t;
    } else {
      dirty = true;
      if (t > maxWatched) maxWatched = t;
    }
    lastTime = t;
  }

  function flush(keepalive) {
    if (!player || typeof player.getDuration !== 'function') return;
    var payload = segments.slice();
    if (segStart !== null && lastTime !== null && lastTime > segStart) payload.push([segStart, lastTime]);
    if (!payload.length && !dirty) return;
    segments = [];
    if (segStart !== null && lastTime !== null) segStart = lastTime;
    dirty = false;
    fetch('/api/progress/' + lessonId, {
      method: 'POST',
      keepalive: !!keepalive,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ segments: payload, position: player.getCurrentTime(), duration: player.getDuration() }),
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (res) {
      if (!res || res.preview) return;
      if (res.completed) {
        if (!completed) {
          completed = true;
          preventSkip = false;
          if (nextBtn) nextBtn.classList.remove('disabled');
        }
        bar.style.width = '100%';
        text.textContent = 'Aula concluída ✅';
      } else {
        bar.style.width = res.percent + '%';
        text.textContent = 'Assistido: ' + res.percent + '% (mínimo ' + threshold + '% para concluir)';
      }
      if (res.courseCompleted) document.getElementById('course-done').classList.remove('hidden');
    }).catch(function () {});
  }

  function onState(e) {
    if (e.data === YT.PlayerState.PLAYING) {
      lastTime = player.getCurrentTime();
      lastWall = Date.now();
      segStart = lastTime;
      if (!sampler) sampler = setInterval(sample, 1000);
    } else {
      if (sampler) { clearInterval(sampler); sampler = null; }
      sample();
      closeSegment();
      lastTime = null;
      flush(false);
    }
  }

  window.onYouTubeIframeAPIReady = function () {
    player = new YT.Player('player', {
      videoId: el.dataset.video,
      playerVars: { rel: 0, modestbranding: 1, playsinline: 1, start: parseInt(el.dataset.start, 10) || 0 },
      events: { onStateChange: onState },
    });
  };
  var tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);

  setInterval(function () { flush(false); }, 10000);
  document.addEventListener('visibilitychange', function () { if (document.hidden) flush(true); });
  window.addEventListener('pagehide', function () { flush(true); });
})();
