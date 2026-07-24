// Silunet — efectos de sonido sintetizados con Web Audio API.
//
// Nada de archivos .mp3 que vendorizar ni bajar de internet (misma razón que
// el QR local: la LAN de la feria es propia, sin salida a internet) y cero
// dependencias nuevas — unos osciladores cortos alcanzan para dar energía en
// un stand. Se usa igual desde /play y desde /master.
const AudioFX = (() => {
  let ctx = null;
  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  // Los navegadores bloquean el audio hasta la primera interacción del
  // usuario -> la "desbloquea" en el primer click/touch/tecla, sin esperar
  // a que algún sonido puntual la necesite primero.
  ['click', 'touchstart', 'keydown'].forEach(evt =>
    document.addEventListener(evt, () => getCtx(), { once: true, passive: true })
  );

  function tone(freq, duration, { type = 'sine', gain = 0.15, delay = 0 } = {}) {
    const audio = getCtx();
    const start = audio.currentTime + delay;
    const osc = audio.createOscillator();
    const g   = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    g.gain.setValueAtTime(gain, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(g).connect(audio.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  return {
    // Últimos segundos del timer (coincide con el estado visual "urgent").
    tick() { tone(880, 0.06, { type: 'square', gain: 0.05 }); },

    // Acierto propio (celular) o de cualquiera (master) — dos notas subiendo.
    correct() {
      tone(659, 0.1, { gain: 0.16 });
      tone(988, 0.16, { gain: 0.14, delay: 0.09 });
    },

    wrong() { tone(160, 0.16, { type: 'sawtooth', gain: 0.1 }); },

    // "3, 2, 1" graves -> "¡YA!" agudo y más largo.
    countdownBeep(isGo) {
      tone(isGo ? 880 : 523, isGo ? 0.32 : 0.13, { type: 'square', gain: isGo ? 0.2 : 0.13 });
    },

    roundEnd(hadWinners) {
      if (hadWinners) {
        [523, 659, 784].forEach((f, i) => tone(f, 0.16, { delay: i * 0.09, gain: 0.15 }));
      } else {
        tone(280, 0.3, { type: 'triangle', gain: 0.12 });
      }
    },

    gameEnd() {
      [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.2, { delay: i * 0.12, gain: 0.16 }));
    },
  };
})();
