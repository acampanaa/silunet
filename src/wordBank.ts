import { WordEntry } from './types';

// Siluetas SVG — todas usan fill="currentColor" para poder cambiar color vía CSS

const MONITOR = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="12" y="12" width="136" height="93" rx="6" fill="currentColor"/>
  <rect x="66" y="103" width="28" height="26" fill="currentColor"/>
  <rect x="42" y="127" width="76" height="12" rx="5" fill="currentColor"/>
</svg>`;

const TECLADO = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="8" y="52" width="144" height="62" rx="10" fill="currentColor"/>
</svg>`;

const RATON = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="80" cy="100" rx="44" ry="50" fill="currentColor"/>
  <ellipse cx="80" cy="58" rx="38" ry="30" fill="currentColor"/>
  <rect x="75" y="10" width="10" height="32" rx="5" fill="currentColor"/>
</svg>`;

const ROUTER = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="18" y="88" width="124" height="46" rx="8" fill="currentColor"/>
  <rect x="42" y="28" width="14" height="65" rx="7" fill="currentColor"/>
  <rect x="104" y="28" width="14" height="65" rx="7" fill="currentColor"/>
</svg>`;

const SERVIDOR = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="38" y="12" width="84" height="136" rx="5" fill="currentColor"/>
</svg>`;

// Forma de nube = círculos superpuestos con base plana
const NUBE = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <circle cx="80"  cy="88" r="46" fill="currentColor"/>
  <circle cx="50"  cy="96" r="30" fill="currentColor"/>
  <circle cx="110" cy="96" r="30" fill="currentColor"/>
  <circle cx="63"  cy="74" r="26" fill="currentColor"/>
  <circle cx="97"  cy="74" r="26" fill="currentColor"/>
  <rect x="22" y="94" width="116" height="50" fill="currentColor"/>
</svg>`;

const TELEFONO = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="46" y="8" width="68" height="144" rx="14" fill="currentColor"/>
</svg>`;

const AUDIFONOS = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <path d="M 26 90 Q 26 28 80 28 Q 134 28 134 90"
        stroke="currentColor" stroke-width="18" fill="none" stroke-linecap="round"/>
  <ellipse cx="22"  cy="104" rx="20" ry="30" fill="currentColor"/>
  <ellipse cx="138" cy="104" rx="20" ry="30" fill="currentColor"/>
</svg>`;

const CAMARA = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="52" width="140" height="88" rx="10" fill="currentColor"/>
  <rect x="55" y="30" width="50" height="26" rx="6" fill="currentColor"/>
  <circle cx="80" cy="96" r="32" fill="currentColor"/>
</svg>`;

// CD/Disco óptico — forma de dona usando fill-rule="evenodd"
const DISCO = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <path fill-rule="evenodd" fill="currentColor"
    d="M80,8 a72,72 0 1,0 0,144 a72,72 0 1,0 0,-144 Z
       M80,64 a16,16 0 1,0 0,32 a16,16 0 1,0 0,-32 Z"/>
</svg>`;

const USB = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="46" y="60" width="68" height="88" rx="8" fill="currentColor"/>
  <rect x="28" y="14" width="104" height="50" rx="5" fill="currentColor"/>
</svg>`;

// Tarjeta SD — pentágono (rectángulo con esquina superior-derecha cortada)
const TARJETA = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <polygon points="36,22 110,22 138,50 138,148 36,148" fill="currentColor"/>
</svg>`;

// ── Ampliación del banco (siguen el mismo estilo: formas geométricas simples,
// fill="currentColor", sin imágenes externas) ──────────────────────────────

// Pantalla vertical + base que se ensancha hacia abajo (vista 3/4 típica de
// laptop abierta) -- a propósito SIN cuello delgado, para no leerse como MONITOR.
const LAPTOP = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="30" y="18" width="100" height="74" rx="4" fill="currentColor"/>
  <path d="M 22 92 L 138 92 L 152 122 L 8 122 Z" fill="currentColor"/>
</svg>`;

const IMPRESORA = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="18" y="60" width="124" height="70" rx="8" fill="currentColor"/>
  <rect x="40" y="30" width="80" height="40" fill="currentColor"/>
  <rect x="55" y="135" width="50" height="10" rx="3" fill="currentColor"/>
</svg>`;

const PROYECTOR = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="16" y="52" width="112" height="58" rx="10" fill="currentColor"/>
  <path fill-rule="evenodd" fill="currentColor"
    d="M128,50 a31,31 0 1,0 0,62 a31,31 0 1,0 0,-62 Z
       M128,66 a15,15 0 1,0 0,30 a15,15 0 1,0 0,-30 Z"/>
</svg>`;

// Forma de bocina/megáfono -- deliberadamente NO son dos círculos apilados
// como RATON, para que no se confundan como silueta dentro de Computadores.
const PARLANTE = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <path d="M 40 55 L 40 105 L 70 105 L 112 142 L 112 18 L 70 55 Z" fill="currentColor"/>
</svg>`;

const VENTILADOR = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <circle cx="80" cy="80" r="14" fill="currentColor"/>
  <ellipse cx="80" cy="35" rx="16" ry="34" fill="currentColor"/>
  <ellipse cx="80" cy="125" rx="16" ry="34" fill="currentColor"/>
  <ellipse cx="35" cy="80" rx="34" ry="16" fill="currentColor"/>
  <ellipse cx="125" cy="80" rx="34" ry="16" fill="currentColor"/>
</svg>`;

const CHIP = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="45" y="45" width="70" height="70" rx="4" fill="currentColor"/>
  <rect x="20" y="55" width="18" height="8" fill="currentColor"/>
  <rect x="20" y="75" width="18" height="8" fill="currentColor"/>
  <rect x="20" y="95" width="18" height="8" fill="currentColor"/>
  <rect x="122" y="55" width="18" height="8" fill="currentColor"/>
  <rect x="122" y="75" width="18" height="8" fill="currentColor"/>
  <rect x="122" y="95" width="18" height="8" fill="currentColor"/>
  <rect x="55" y="20" width="8" height="18" fill="currentColor"/>
  <rect x="75" y="20" width="8" height="18" fill="currentColor"/>
  <rect x="97" y="20" width="8" height="18" fill="currentColor"/>
  <rect x="55" y="122" width="8" height="18" fill="currentColor"/>
  <rect x="75" y="122" width="8" height="18" fill="currentColor"/>
  <rect x="97" y="122" width="8" height="18" fill="currentColor"/>
</svg>`;

const MEMORIA = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="40" y="30" width="80" height="110" rx="4" fill="currentColor"/>
  <rect x="48" y="10" width="12" height="24" fill="currentColor"/>
  <rect x="68" y="10" width="12" height="24" fill="currentColor"/>
  <rect x="88" y="10" width="12" height="24" fill="currentColor"/>
  <rect x="108" y="10" width="12" height="24" fill="currentColor"/>
</svg>`;

const JOYSTICK = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="20" y="120" width="120" height="26" rx="8" fill="currentColor"/>
  <rect x="72" y="55" width="16" height="70" fill="currentColor"/>
  <circle cx="80" cy="45" r="26" fill="currentColor"/>
</svg>`;

const MODEM = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="15" y="70" width="130" height="55" rx="10" fill="currentColor"/>
  <circle cx="35" cy="70" r="8" fill="currentColor"/>
  <circle cx="58" cy="70" r="8" fill="currentColor"/>
  <circle cx="81" cy="70" r="8" fill="currentColor"/>
</svg>`;

const ANTENA = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <path d="M 20 75 A 60 55 0 0 1 140 75 L 130 85 A 50 45 0 0 0 30 85 Z" fill="currentColor"/>
  <circle cx="80" cy="45" r="8" fill="currentColor"/>
  <rect x="74" y="80" width="12" height="55" fill="currentColor"/>
  <rect x="50" y="130" width="60" height="12" rx="4" fill="currentColor"/>
</svg>`;

const SWITCH_ICON = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="60" width="140" height="30" rx="6" fill="currentColor"/>
  <rect x="24" y="82" width="10" height="14" fill="currentColor"/>
  <rect x="44" y="82" width="10" height="14" fill="currentColor"/>
  <rect x="64" y="82" width="10" height="14" fill="currentColor"/>
  <rect x="86" y="82" width="10" height="14" fill="currentColor"/>
  <rect x="106" y="82" width="10" height="14" fill="currentColor"/>
  <rect x="126" y="82" width="10" height="14" fill="currentColor"/>
</svg>`;

const SATELITE = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="65" y="60" width="30" height="40" rx="4" fill="currentColor"/>
  <rect x="10" y="55" width="45" height="50" fill="currentColor"/>
  <rect x="105" y="55" width="45" height="50" fill="currentColor"/>
  <circle cx="80" cy="45" r="10" fill="currentColor"/>
  <rect x="76" y="20" width="8" height="25" fill="currentColor"/>
</svg>`;

const CABLE = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <path d="M20 80 Q 45 40, 70 80 T 120 80 T 160 80" stroke="currentColor" stroke-width="14" fill="none" stroke-linecap="round"/>
  <rect x="15" y="70" width="20" height="20" rx="4" fill="currentColor"/>
</svg>`;

const TORRE = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <polygon points="72,10 88,10 118,145 42,145" fill="currentColor"/>
  <rect x="35" y="145" width="90" height="10" rx="3" fill="currentColor"/>
</svg>`;

const WIFI = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <circle cx="80" cy="130" r="10" fill="currentColor"/>
  <path d="M 45 100 Q 80 70 115 100" stroke="currentColor" stroke-width="12" fill="none" stroke-linecap="round"/>
  <path d="M 20 70 Q 80 20 140 70" stroke="currentColor" stroke-width="12" fill="none" stroke-linecap="round"/>
</svg>`;

const RELOJ = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="45" y="10" width="70" height="24" rx="6" fill="currentColor"/>
  <rect x="45" y="126" width="70" height="24" rx="6" fill="currentColor"/>
  <rect x="38" y="42" width="84" height="76" rx="18" fill="currentColor"/>
  <rect x="120" y="70" width="10" height="20" rx="3" fill="currentColor"/>
</svg>`;

const CONTROL = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="20" y="55" width="120" height="55" rx="20" fill="currentColor"/>
  <circle cx="35" cy="110" r="26" fill="currentColor"/>
  <circle cx="125" cy="110" r="26" fill="currentColor"/>
</svg>`;

const DRON = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="65" y="65" width="30" height="30" rx="6" fill="currentColor"/>
  <rect x="35" y="43" width="90" height="10" rx="4" transform="rotate(45 80 80)" fill="currentColor"/>
  <rect x="35" y="107" width="90" height="10" rx="4" transform="rotate(-45 80 80)" fill="currentColor"/>
  <circle cx="35" cy="35" r="18" fill="currentColor"/>
  <circle cx="125" cy="35" r="18" fill="currentColor"/>
  <circle cx="35" cy="125" r="18" fill="currentColor"/>
  <circle cx="125" cy="125" r="18" fill="currentColor"/>
</svg>`;

const MICROFONO = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="60" y="10" width="40" height="80" rx="20" fill="currentColor"/>
  <path d="M 40 70 A 40 40 0 0 0 120 70" stroke="currentColor" stroke-width="10" fill="none" stroke-linecap="round"/>
  <rect x="75" y="105" width="10" height="35" fill="currentColor"/>
  <rect x="55" y="140" width="50" height="10" rx="4" fill="currentColor"/>
</svg>`;

const LENTES = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="12" y="60" width="55" height="45" rx="16" fill="currentColor"/>
  <rect x="93" y="60" width="55" height="45" rx="16" fill="currentColor"/>
  <rect x="67" y="76" width="26" height="10" rx="4" fill="currentColor"/>
</svg>`;

const TERMOSTATO = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <path fill-rule="evenodd" fill="currentColor"
    d="M80,15 a65,65 0 1,0 0,130 a65,65 0 1,0 0,-130 Z
       M80,45 a35,35 0 1,0 0,70 a35,35 0 1,0 0,-70 Z"/>
</svg>`;

const TIMBRE = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="60" y="15" width="40" height="130" rx="14" fill="currentColor"/>
  <circle cx="80" cy="60" r="26" fill="currentColor"/>
</svg>`;

const DISCODURO = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="15" y="55" width="130" height="55" rx="10" fill="currentColor"/>
  <circle cx="125" cy="55" r="8" fill="currentColor"/>
</svg>`;

const DISQUETE = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <path fill-rule="evenodd" fill="currentColor" d="
    M20,20 L120,20 L140,40 L140,140 L20,140 Z
    M45,20 L95,20 L95,55 L45,55 Z"/>
</svg>`;

const CINTA = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <path fill-rule="evenodd" fill="currentColor" d="
    M15,50 h130 a8,8 0 0 1 8,8 v55 a8,8 0 0 1 -8,8 h-130 a8,8 0 0 1 -8,-8 v-55 a8,8 0 0 1 8,-8 Z
    M55,80 a18,18 0 1,0 0,36 a18,18 0 1,0 0,-36 Z
    M105,80 a18,18 0 1,0 0,36 a18,18 0 1,0 0,-36 Z"/>
</svg>`;

export const WORD_BANK: WordEntry[] = [
  { word: 'MONITOR',    category: 'Computadores',   svg: MONITOR    },
  { word: 'TECLADO',    category: 'Computadores',   svg: TECLADO    },
  { word: 'RATON',      category: 'Computadores',   svg: RATON      },
  { word: 'LAPTOP',     category: 'Computadores',   svg: LAPTOP     },
  { word: 'IMPRESORA',  category: 'Computadores',   svg: IMPRESORA  },
  { word: 'PROYECTOR',  category: 'Computadores',   svg: PROYECTOR  },
  { word: 'PARLANTE',   category: 'Computadores',   svg: PARLANTE   },
  { word: 'VENTILADOR', category: 'Computadores',   svg: VENTILADOR },
  { word: 'CHIP',       category: 'Computadores',   svg: CHIP       },
  { word: 'MEMORIA',    category: 'Computadores',   svg: MEMORIA    },
  { word: 'JOYSTICK',   category: 'Computadores',   svg: JOYSTICK   },

  { word: 'ROUTER',    category: 'Redes',  svg: ROUTER      },
  { word: 'SERVIDOR',  category: 'Redes',  svg: SERVIDOR    },
  { word: 'NUBE',      category: 'Redes',  svg: NUBE        },
  { word: 'MODEM',     category: 'Redes',  svg: MODEM       },
  { word: 'ANTENA',    category: 'Redes',  svg: ANTENA      },
  { word: 'SWITCH',    category: 'Redes',  svg: SWITCH_ICON },
  { word: 'SATELITE',  category: 'Redes',  svg: SATELITE    },
  { word: 'CABLE',     category: 'Redes',  svg: CABLE       },
  { word: 'TORRE',     category: 'Redes',  svg: TORRE       },
  { word: 'WIFI',      category: 'Redes',  svg: WIFI        },

  { word: 'TELEFONO',   category: 'Dispositivos',  svg: TELEFONO   },
  { word: 'AUDIFONOS',  category: 'Dispositivos',  svg: AUDIFONOS  },
  { word: 'CAMARA',     category: 'Dispositivos',  svg: CAMARA     },
  { word: 'RELOJ',      category: 'Dispositivos',  svg: RELOJ      },
  { word: 'CONTROL',    category: 'Dispositivos',  svg: CONTROL    },
  { word: 'DRON',       category: 'Dispositivos',  svg: DRON       },
  { word: 'MICROFONO',  category: 'Dispositivos',  svg: MICROFONO  },
  { word: 'LENTES',     category: 'Dispositivos',  svg: LENTES     },
  { word: 'TERMOSTATO', category: 'Dispositivos',  svg: TERMOSTATO },
  { word: 'TIMBRE',     category: 'Dispositivos',  svg: TIMBRE     },

  { word: 'DISCO',      category: 'Almacenamiento',  svg: DISCO     },
  { word: 'USB',        category: 'Almacenamiento',  svg: USB       },
  { word: 'TARJETA',    category: 'Almacenamiento',  svg: TARJETA   },
  { word: 'DISCODURO',  category: 'Almacenamiento',  svg: DISCODURO },
  { word: 'DISQUETE',   category: 'Almacenamiento',  svg: DISQUETE  },
  { word: 'CINTA',      category: 'Almacenamiento',  svg: CINTA     },
];

/** Categorías reales del banco con cuántas palabras tiene cada una, para que
 *  el master pueda ofrecerlas como checkboxes sin inventar contenido nuevo. */
export function getCategoryCounts(): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const w of WORD_BANK) counts.set(w.category, (counts.get(w.category) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => ({ name, count }));
}

/**
 * `categories`: si se pasa (no vacío), solo elige palabras de esas categorías.
 * Si el filtro deja el banco vacío (p.ej. nombres que ya no existen), cae de
 * vuelta al banco completo en vez de dejar una partida sin palabras.
 */
export function getRandomRounds(count: number, categories?: string[]): WordEntry[] {
  const filtered = categories && categories.length > 0
    ? WORD_BANK.filter(w => categories.includes(w.category))
    : WORD_BANK;
  const pool = filtered.length > 0 ? filtered : WORD_BANK;
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, pool.length));
}
