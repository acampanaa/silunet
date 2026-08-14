// ── Galería de avatares ──────────────────────────────────────────────────────
//
// Identidad visual del jugador. Cada avatar es una forma + un color distintos,
// para que en la pantalla maestra se reconozca de un vistazo quién va ganando
// (la forma sola no basta a distancia; el color solo tampoco, si alguien es
// daltónico — por eso van los dos juntos).
//
// CLAVE distribuida: por la red viaja SOLO el índice (`avatarId`, un número).
// El dibujo se arma en el cliente. Así el avatar puede ir dentro de RANKING
// —que se difunde constantemente— sin sumarle peso al canal del juego (Eje 1).
// Las fotos subidas por el jugador NO pueden hacer esto: ver paso 2.

(function () {
  const AVATARS = [
    { color: '#F0439B', glyph: '<circle cx="12" cy="12" r="6.5"/>' },
    { color: '#22D3EE', glyph: '<path d="M12 4.5l7.5 13.5h-15z"/>' },
    { color: '#A3E635', glyph: '<rect x="5.5" y="5.5" width="13" height="13" rx="2.5"/>' },
    { color: '#FBBF24', glyph: '<path d="M12 3.5l8.5 8.5-8.5 8.5-8.5-8.5z"/>' },
    { color: '#FB7185', glyph: '<path d="M12 3.5l2.5 5.4 5.9.75-4.4 4.05 1.15 5.85L12 16.7l-5.15 2.85L8 13.7 3.6 9.65l5.9-.75z"/>' },
    { color: '#818CF8', glyph: '<path d="M13.5 2.5L5.5 13.5h5l-1 8 8-11h-5z"/>' },
    { color: '#34D399', glyph: '<path d="M12 20.5s-7.5-4.6-7.5-9.6a4.3 4.3 0 017.5-2.8 4.3 4.3 0 017.5 2.8c0 5-7.5 9.6-7.5 9.6z"/>' },
    { color: '#F97316', glyph: '<path d="M12 2.8l8.2 4.7v9.4L12 21.2l-8.2-4.3V7.5z"/>' },
    { color: '#C084FC', glyph: '<path d="M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17zm0 4.7a3.8 3.8 0 110 7.6 3.8 3.8 0 010-7.6z"/>' },
    { color: '#38BDF8', glyph: '<path d="M9.8 3.5h4.4v6.3h6.3v4.4h-6.3v6.3H9.8v-6.3H3.5V9.8h6.3z"/>' },
    { color: '#2DD4BF', glyph: '<path d="M12 2.8s6.4 6.9 6.4 11.1a6.4 6.4 0 01-12.8 0C5.6 9.7 12 2.8 12 2.8z"/>' },
    { color: '#FACC15', glyph: '<path d="M15.6 2.8a9.2 9.2 0 106.1 15.4A9.2 9.2 0 0115.6 2.8z"/>' },
  ];

  /** Cuántos avatares hay (para pintar la galería). */
  function avatarCount() { return AVATARS.length; }

  /** Normaliza cualquier valor a un índice válido (datos viejos / corruptos). */
  function normalizeAvatarId(id) {
    const n = Number(id);
    return Number.isInteger(n) && n >= 0 && n < AVATARS.length ? n : 0;
  }

  /**
   * Devuelve el SVG del avatar como string, listo para innerHTML.
   * `size` es un CSS length ('32px', '2.4rem'…) — el círculo se adapta solo.
   */
  function avatarSVG(id, size = '2rem') {
    const a = AVATARS[normalizeAvatarId(id)];
    return `<svg class="avatar" viewBox="0 0 24 24" role="img" aria-hidden="true"
        style="width:${size};height:${size}">
        <circle cx="12" cy="12" r="12" fill="${a.color}" opacity="0.18"/>
        <g fill="${a.color}">${a.glyph}</g>
      </svg>`;
  }

  function avatarHTML(id, key, size = '2rem', alt = '') {
    const validKey = typeof key === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key);
    if (!validKey) return avatarSVG(id, size);
    const safeAlt = String(alt).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
    const assetBase = window.__silunetAssetBase || '';
    return `<img class="avatar avatar-photo" src="${assetBase}/api/avatar/${key}"
      alt="${safeAlt}" width="96" height="96" decoding="async"
      style="width:${size};height:${size}">`;
  }

  window.SilunetAvatars = { avatarSVG, avatarHTML, avatarCount, normalizeAvatarId };
})();
