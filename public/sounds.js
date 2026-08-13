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

  // Silencio de efectos. Se recuerda en el navegador para que el operador no
  // tenga que volver a silenciar después de cada recarga.
  const CLAVE_MUDO = 'silunet_efectos_mudos';
  let mudo = false;
  try { mudo = localStorage.getItem(CLAVE_MUDO) === '1'; } catch { /* modo privado */ }

  function tone(freq, duration, { type = 'sine', gain = 0.15, delay = 0 } = {}) {
    if (mudo) return;
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

  const api = {
    /** ¿Están silenciados los efectos en este dispositivo? */
    estaMudo() { return mudo; },

    /** Silencia o reactiva los efectos y lo recuerda para la próxima visita. */
    setMudo(valor) {
      mudo = Boolean(valor);
      try { localStorage.setItem(CLAVE_MUDO, mudo ? '1' : '0'); } catch { /* modo privado */ }
      return mudo;
    },

    // Pasar el mouse por un botón. Es el sonido más suave y corto de todos:
    // ocurre decenas de veces por minuto y tiene que sentirse como un tic, no
    // como un aviso.
    //
    // No lleva ninguna guarda extra: se comporta igual que el resto. Antes
    // tenía un `if (!ctx) return` para no crear el contexto de audio a puro
    // hover, pero eso lo dejaba mudo indefinidamente si el usuario recorría la
    // pantalla sin hacer clic. El navegador ya se encarga: hasta el primer
    // gesto real el contexto queda suspendido y no se oye nada.
    hover() { tone(1175, 0.05, { type: 'square', gain: 0.09 }); },

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

  // El hover se engancha una sola vez y por delegación, así cualquier botón
  // —los que ya existen y los que se creen después— suena sin tener que tocar
  // cada pantalla.
  let ultimoHover = 0;
  document.addEventListener('pointerover', event => {
    // En pantallas táctiles un toque dispara 'pointerover' y sonaría junto al
    // click: el hover es solo para mouse.
    if (event.pointerType !== 'mouse') return;

    const boton = event.target.closest?.('button');
    if (!boton || boton.disabled) return;

    // 'pointerover' burbujea desde los hijos del botón (íconos, spans): si el
    // puntero venía de adentro del mismo botón, no es una entrada nueva.
    if (event.relatedTarget && boton.contains(event.relatedTarget)) return;

    // Freno para que barrer varios botones seguidos no suene a ametralladora.
    const ahora = performance.now();
    if (ahora - ultimoHover < 70) return;
    ultimoHover = ahora;

    api.hover();
  }, { passive: true });

  return api;
})();
