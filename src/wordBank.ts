import { WordEntry, Difficulty } from './types';

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

// Silueta pendiente de dibujar: recuadro punteado con un "?" dentro. Es a
// propósito distinta de cualquier silueta real (nadie la va a confundir con
// un objeto) para que se note de una cuál falta ilustrar.
const PLACEHOLDER = `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
  <rect x="22" y="22" width="116" height="116" rx="14" fill="none"
        stroke="currentColor" stroke-width="5" stroke-dasharray="11 9" opacity="0.45"/>
  <path d="M 60 62 a 20 20 0 1 1 20 26 v 8" fill="none"
        stroke="currentColor" stroke-width="11" stroke-linecap="round"/>
  <circle cx="80" cy="112" r="7" fill="currentColor"/>
</svg>`;

/**
 * Siluetas ya dibujadas. Todo lo que NO esté aquí sale con PLACEHOLDER: para
 * ilustrar una palabra nueva basta agregar su constante SVG arriba y sumarla
 * a este mapa — no hay que tocar las listas de categorías de abajo.
 */
const ART: Record<string, string> = {
  MONITOR, TECLADO, RATON, LAPTOP, IMPRESORA, PROYECTOR, PARLANTE, VENTILADOR,
  CHIP, MEMORIA, JOYSTICK,
  ROUTER, SERVIDOR, NUBE, MODEM, ANTENA, SWITCH: SWITCH_ICON, SATELITE, CABLE,
  TORRE, WIFI,
  TELEFONO, AUDIFONOS, CAMARA, RELOJ, CONTROL, DRON, MICROFONO, LENTES,
  TERMOSTATO, TIMBRE,
  DISCO, USB, TARJETA, DISCODURO, DISQUETE, CINTA,
};

/**
 * Dificultad derivada del LARGO de la palabra (no anotada a mano): así el
 * banco se mantiene solo — agregar una palabra nueva la clasifica sola, y no
 * hay forma de que la etiqueta y la palabra se desincronicen.
 */
export function difficultyOf(word: string): Difficulty {
  const n = word.replace(/ /g, '').length;
  if (n <= 5) return 'facil';
  if (n <= 8) return 'intermedio';
  return 'dificil';
}

export const DIFFICULTIES: Difficulty[] = ['facil', 'intermedio', 'dificil'];

/** Etiqueta legible para la pantalla de votación. */
export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  facil:      'Fácil',
  intermedio: 'Intermedio',
  dificil:    'Difícil',
};

// Cada temática tiene 20 palabras, repartidas ~6 fáciles (≤5 letras),
// ~8 intermedias (6-8) y ~6 difíciles (9+), para que cualquier combinación
// de categoría + dificultad que salga votada tenga suficientes rondas.
const CATEGORIES: Record<string, string[]> = {
  'Computadores': [
    'CHIP', 'RATON', 'PLACA', 'TECLA', 'BOTON', 'PIXEL',
    'LAPTOP', 'WEBCAM', 'MONITOR', 'TECLADO', 'MEMORIA', 'PARLANTE', 'JOYSTICK', 'PANTALLA',
    'IMPRESORA', 'PROYECTOR', 'MICROCHIP', 'ORDENADOR', 'VENTILADOR', 'PROCESADOR',
  ],
  'Redes': [
    'NUBE', 'WIFI', 'MODEM', 'CABLE', 'TORRE', 'FIBRA',
    'ROUTER', 'ANTENA', 'SWITCH', 'PAQUETE', 'SERVIDOR', 'SATELITE', 'FIREWALL', 'ETHERNET',
    'PROTOCOLO', 'REPETIDOR', 'ENRUTADOR', 'NAVEGADOR', 'CONMUTADOR', 'CORTAFUEGOS',
  ],
  'Dispositivos': [
    'DRON', 'FOCO', 'RELOJ', 'RADIO', 'MANDO', 'CASCO',
    'CAMARA', 'LENTES', 'TIMBRE', 'ALARMA', 'SENSOR', 'CONTROL', 'TABLETA', 'TELEFONO',
    'AUDIFONOS', 'MICROFONO', 'TELEVISOR', 'TERMOSTATO', 'SMARTWATCH', 'ASPIRADORA',
  ],
  'Almacenamiento': [
    'USB', 'RAM', 'ROM', 'DISCO', 'CINTA', 'CACHE',
    'BACKUP', 'SECTOR', 'TARJETA', 'ARCHIVO', 'CARPETA', 'VOLUMEN', 'DISQUETE', 'RESPALDO',
    'DISCODURO', 'PARTICION', 'DIRECTORIO', 'ALMACENAJE', 'COMPRESION', 'REPOSITORIO',
  ],
  'Animales': [
    'OSO', 'PEZ', 'GATO', 'PATO', 'LEON', 'PERRO',
    'CONEJO', 'DELFIN', 'CABALLO', 'TORTUGA', 'GALLINA', 'ELEFANTE', 'CANGREJO', 'MARIPOSA',
    'SERPIENTE', 'COCODRILO', 'MARIQUITA', 'MURCIELAGO', 'HIPOPOTAMO', 'RINOCERONTE',
  ],
  'Comida': [
    'PAN', 'UVA', 'PERA', 'TACO', 'HUEVO', 'QUESO',
    'BANANA', 'SANDIA', 'TOMATE', 'HELADO', 'MANZANA', 'NARANJA', 'PLATANO', 'GALLETA',
    'CHOCOLATE', 'ZANAHORIA', 'MANDARINA', 'ESPAGUETI', 'PALOMITAS', 'HAMBURGUESA',
  ],
  'Transporte': [
    'MOTO', 'TREN', 'BOTE', 'TAXI', 'BARCO', 'AVION',
    'CAMION', 'LANCHA', 'COHETE', 'VELERO', 'TRACTOR', 'AUTOBUS', 'CARRETA', 'PATINETA',
    'BICICLETA', 'SUBMARINO', 'CAMIONETA', 'AMBULANCIA', 'HELICOPTERO', 'MOTOCICLETA',
  ],
  'Instrumentos': [
    'ARPA', 'GONG', 'LIRA', 'TUBA', 'PIANO', 'BANJO',
    'FLAUTA', 'VIOLIN', 'TAMBOR', 'BATERIA', 'MARACAS', 'UKELELE', 'GUITARRA', 'TROMPETA',
    'CLARINETE', 'PANDERETA', 'MANDOLINA', 'CONTRABAJO', 'VIOLONCHELO', 'SINTETIZADOR',
  ],
};

// Pistas redactadas a mano: describen uso, contexto o una propiedad reconocible
// sin incluir la respuesta ni una variante directa de ella.
const HINTS: Record<string, string> = {
  // Computadores
  CHIP: 'Es una pieza diminuta que puede realizar millones de operaciones.',
  RATON: 'Se desplaza sobre una superficie para controlar el puntero.',
  PLACA: 'Sirve como base para conectar los componentes internos.',
  TECLA: 'Cada una representa una entrada que se presiona con los dedos.',
  BOTON: 'Activa una acción cuando se presiona.',
  PIXEL: 'Es la unidad de color más pequeña que ves en una pantalla.',
  LAPTOP: 'Combina pantalla y teclado en un equipo que se puede transportar.',
  WEBCAM: 'Captura video para llamadas y transmisiones desde un equipo.',
  MONITOR: 'Muestra de forma visual lo que procesa el equipo.',
  TECLADO: 'Permite escribir mediante un conjunto ordenado de piezas.',
  MEMORIA: 'Mantiene datos disponibles mientras se realizan tareas.',
  PARLANTE: 'Convierte señales eléctricas en sonido audible.',
  JOYSTICK: 'Se inclina en distintas direcciones para controlar movimientos.',
  PANTALLA: 'Es la superficie donde aparecen imágenes, texto y video.',
  IMPRESORA: 'Pasa información digital a una hoja física.',
  PROYECTOR: 'Amplía una imagen y la lanza sobre una superficie.',
  MICROCHIP: 'Concentra circuitos electrónicos en una pieza muy pequeña.',
  ORDENADOR: 'Procesa instrucciones y datos para ejecutar programas.',
  VENTILADOR: 'Mueve aire para evitar que los componentes se calienten.',
  PROCESADOR: 'Ejecuta las instrucciones principales de un sistema.',

  // Redes
  NUBE: 'Permite usar recursos remotos a través de internet.',
  WIFI: 'Conecta dispositivos sin necesidad de cables.',
  MODEM: 'Adapta la señal del proveedor para dar acceso a internet.',
  CABLE: 'Transporta señales mediante una conexión física.',
  TORRE: 'Eleva equipos de comunicación para ampliar su alcance.',
  FIBRA: 'Transporta información mediante pulsos de luz.',
  ROUTER: 'Decide por dónde enviar los datos entre varias conexiones.',
  ANTENA: 'Emite o recibe señales a través del aire.',
  SWITCH: 'Une varios equipos dentro de una misma red local.',
  PAQUETE: 'Es una pequeña porción de información enviada por la red.',
  SERVIDOR: 'Ofrece recursos o servicios a otros equipos.',
  SATELITE: 'Retransmite señales desde una órbita alrededor del planeta.',
  FIREWALL: 'Filtra conexiones para bloquear tráfico no permitido.',
  ETHERNET: 'Es una tecnología común para redes locales por conexión física.',
  PROTOCOLO: 'Define las reglas que permiten comunicarse a dos sistemas.',
  REPETIDOR: 'Recibe una señal debilitada y la vuelve a transmitir.',
  ENRUTADOR: 'Selecciona el camino que seguirán los datos.',
  NAVEGADOR: 'Interpreta sitios y permite recorrer contenido de internet.',
  CONMUTADOR: 'Envía datos al puerto correcto dentro de una red local.',
  CORTAFUEGOS: 'Actúa como una barrera que inspecciona el tráfico digital.',

  // Dispositivos
  DRON: 'Puede volar sin llevar un piloto en su interior.',
  FOCO: 'Produce iluminación al recibir energía.',
  RELOJ: 'Sirve para consultar y medir el paso del tiempo.',
  RADIO: 'Recibe transmisiones de audio enviadas a distancia.',
  MANDO: 'Permite controlar un aparato desde cierta distancia.',
  CASCO: 'Se coloca sobre la cabeza como protección o accesorio tecnológico.',
  CAMARA: 'Captura escenas y las convierte en imágenes.',
  LENTES: 'Se colocan frente a los ojos para mejorar o ampliar la visión.',
  TIMBRE: 'Emite un aviso cuando alguien lo acciona.',
  ALARMA: 'Advierte de una situación mediante sonido o luz.',
  SENSOR: 'Detecta cambios del entorno y los convierte en datos.',
  CONTROL: 'Tiene botones para manejar otro equipo sin tocarlo directamente.',
  TABLETA: 'Es una superficie táctil portátil mayor que un teléfono.',
  TELEFONO: 'Permite comunicarse a distancia y cabe en una mano.',
  AUDIFONOS: 'Llevan el sonido directamente a los oídos.',
  MICROFONO: 'Convierte la voz y otros sonidos en una señal.',
  TELEVISOR: 'Recibe y muestra contenido audiovisual.',
  TERMOSTATO: 'Regula automáticamente la temperatura de un espacio.',
  SMARTWATCH: 'Se lleva en la muñeca y ejecuta funciones digitales.',
  ASPIRADORA: 'Retira polvo y residuos mediante succión.',

  // Almacenamiento
  USB: 'Es pequeño, portátil y se conecta directamente a un puerto.',
  RAM: 'Guarda temporalmente lo que el sistema está usando ahora.',
  ROM: 'Conserva instrucciones incluso cuando se corta la energía.',
  DISCO: 'Guarda información sobre una superficie circular.',
  CINTA: 'Almacena datos de forma secuencial en una banda magnética.',
  CACHE: 'Conserva datos frecuentes para acceder a ellos más rápido.',
  BACKUP: 'Es una copia preparada para recuperar información perdida.',
  SECTOR: 'Es una división pequeña dentro de una unidad de datos.',
  TARJETA: 'Es un soporte delgado y removible usado en cámaras y teléfonos.',
  ARCHIVO: 'Agrupa información bajo un nombre dentro del sistema.',
  CARPETA: 'Sirve para organizar varios elementos digitales.',
  VOLUMEN: 'Es una unidad lógica que el sistema trata como espacio independiente.',
  DISQUETE: 'Fue un soporte removible muy usado antes de las memorias modernas.',
  RESPALDO: 'Permite restaurar datos después de una pérdida o daño.',
  DISCODURO: 'Guarda grandes cantidades de datos de manera permanente.',
  PARTICION: 'Divide una unidad física en espacios lógicos separados.',
  DIRECTORIO: 'Organiza elementos mediante una estructura jerárquica.',
  ALMACENAJE: 'Es la acción de conservar datos para utilizarlos después.',
  COMPRESION: 'Reduce el espacio que ocupa la información.',
  REPOSITORIO: 'Centraliza y conserva archivos o versiones de un proyecto.',

  // Animales
  OSO: 'Es un mamífero grande que puede pasar el invierno en una guarida.',
  PEZ: 'Vive en el agua y respira mediante branquias.',
  GATO: 'Es un felino doméstico conocido por su agilidad.',
  PATO: 'Es un ave acuática con pico ancho y patas palmeadas.',
  LEON: 'Es un gran felino cuyo macho suele tener melena.',
  PERRO: 'Es un animal doméstico famoso por su lealtad.',
  CONEJO: 'Tiene orejas largas y se desplaza dando saltos.',
  DELFIN: 'Es un mamífero marino inteligente y sociable.',
  CABALLO: 'Ha sido utilizado para montar y tirar de vehículos.',
  TORTUGA: 'Lleva una cubierta rígida que protege su cuerpo.',
  GALLINA: 'Es un ave de corral que pone huevos.',
  ELEFANTE: 'Es un mamífero enorme con trompa y grandes orejas.',
  CANGREJO: 'Tiene pinzas y suele desplazarse de lado.',
  MARIPOSA: 'Cambia por metamorfosis y tiene alas coloridas.',
  SERPIENTE: 'Se desplaza sin patas y posee un cuerpo alargado.',
  COCODRILO: 'Es un gran reptil semiacuático con mandíbula poderosa.',
  MARIQUITA: 'Es un insecto pequeño, redondo y normalmente tiene puntos.',
  MURCIELAGO: 'Es el único mamífero capaz de vuelo sostenido.',
  HIPOPOTAMO: 'Pasa gran parte del día en el agua pese a ser terrestre.',
  RINOCERONTE: 'Es un mamífero robusto con uno o más cuernos en el hocico.',

  // Comida
  PAN: 'Se prepara horneando una masa hecha principalmente con harina.',
  UVA: 'Es una fruta pequeña que crece agrupada en racimos.',
  PERA: 'Es una fruta de base ancha y parte superior estrecha.',
  TACO: 'Consiste en una tortilla doblada alrededor de un relleno.',
  HUEVO: 'Tiene cáscara y se usa en innumerables preparaciones.',
  QUESO: 'Se obtiene al transformar y madurar leche.',
  BANANA: 'Es una fruta alargada con cáscara amarilla.',
  SANDIA: 'Es grande, verde por fuera y muy jugosa por dentro.',
  TOMATE: 'Es rojo al madurar y se usa mucho en salsas y ensaladas.',
  HELADO: 'Es un postre frío de textura cremosa.',
  MANZANA: 'Es una fruta redonda asociada con huertos de clima templado.',
  NARANJA: 'Es un cítrico redondo de color intenso.',
  PLATANO: 'Es una fruta curva que se pela antes de comer.',
  GALLETA: 'Es una porción pequeña y horneada, normalmente crujiente.',
  CHOCOLATE: 'Se elabora a partir de semillas de una planta tropical.',
  ZANAHORIA: 'Es una raíz comestible, generalmente de color anaranjado.',
  MANDARINA: 'Es un cítrico pequeño cuya cáscara se retira fácilmente.',
  ESPAGUETI: 'Es una pasta larga y delgada que suele servirse con salsa.',
  PALOMITAS: 'Se forman cuando ciertos granos revientan con el calor.',
  HAMBURGUESA: 'Lleva un relleno redondo entre dos partes de un pan.',

  // Transporte
  MOTO: 'Tiene dos ruedas y un motor, pero no se pedalea.',
  TREN: 'Circula sobre rieles y puede arrastrar varios vagones.',
  BOTE: 'Es una embarcación pequeña para desplazarse sobre el agua.',
  TAXI: 'Transporta pasajeros a cambio de una tarifa.',
  BARCO: 'Es una embarcación capaz de recorrer mares o ríos.',
  AVION: 'Tiene alas y transporta personas o carga por el aire.',
  CAMION: 'Está diseñado principalmente para transportar carga pesada.',
  LANCHA: 'Es una embarcación pequeña y rápida, normalmente con motor.',
  COHETE: 'Se impulsa expulsando gases y puede viajar fuera de la atmósfera.',
  VELERO: 'Aprovecha el viento para moverse sobre el agua.',
  TRACTOR: 'Se utiliza en el campo para arrastrar maquinaria agrícola.',
  AUTOBUS: 'Lleva numerosos pasajeros siguiendo una ruta.',
  CARRETA: 'Es un vehículo sencillo que suele ser tirado por animales.',
  PATINETA: 'Es una tabla con ruedas sobre la que se viaja de pie.',
  BICICLETA: 'Tiene dos ruedas y avanza mediante pedales.',
  SUBMARINO: 'Puede navegar durante largos periodos bajo el agua.',
  CAMIONETA: 'Es un vehículo versátil con espacio para carga o pasajeros.',
  AMBULANCIA: 'Transporta pacientes y cuenta con equipo de emergencia.',
  HELICOPTERO: 'Sus aspas le permiten elevarse verticalmente y quedar suspendido.',
  MOTOCICLETA: 'Es un vehículo motorizado de dos ruedas que se conduce sentado.',

  // Instrumentos
  ARPA: 'Sus numerosas cuerdas se pulsan dentro de un marco triangular.',
  GONG: 'Es un gran disco metálico que se golpea y produce resonancia.',
  LIRA: 'Tiene cuerdas sujetas a un marco abierto de origen antiguo.',
  TUBA: 'Es un instrumento de viento metálico con sonido muy grave.',
  PIANO: 'Sus teclas activan mecanismos que golpean cuerdas internas.',
  BANJO: 'Tiene cuerdas y una caja circular cubierta por una membrana.',
  FLAUTA: 'Produce sonido al soplar aire a través de un tubo.',
  VIOLIN: 'Se apoya cerca del hombro y normalmente se toca con arco.',
  TAMBOR: 'Su membrana produce sonido al ser golpeada.',
  BATERIA: 'Agrupa varias piezas de percusión para tocarlas en conjunto.',
  MARACAS: 'Se agitan con las manos para producir ritmo.',
  UKELELE: 'Es pequeño, tiene cuatro cuerdas y origen hawaiano.',
  GUITARRA: 'Normalmente tiene seis cuerdas y se toca con ambas manos.',
  TROMPETA: 'Es de metal, se sopla y suele tener tres válvulas.',
  CLARINETE: 'Es un tubo de viento con llaves y una lengüeta.',
  PANDERETA: 'Combina una membrana circular con pequeñas piezas metálicas.',
  MANDOLINA: 'Es de cuerdas, cuerpo pequeño y suele tocarse con púa.',
  CONTRABAJO: 'Es el miembro más grande y grave de su familia de cuerdas.',
  VIOLONCHELO: 'Se toca sentado, apoyado en el suelo y usando un arco.',
  SINTETIZADOR: 'Genera sonidos electrónicos que pueden imitar otros instrumentos.',
};

const missingHints = Object.values(CATEGORIES).flat().filter(word => !HINTS[word]);
if (missingHints.length > 0) {
  throw new Error(`Faltan pistas para: ${missingHints.join(', ')}`);
}

export const WORD_BANK: WordEntry[] = Object.entries(CATEGORIES).flatMap(
  ([category, words]) => words.map(word => ({
    word,
    category,
    svg: ART[word] ?? PLACEHOLDER,
    hint: HINTS[word],
    difficulty: difficultyOf(word),
  })),
);

/** Categorías reales del banco con cuántas palabras tiene cada una, para que
 *  el master pueda ofrecerlas como checkboxes sin inventar contenido nuevo. */
export function getCategoryCounts(): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const w of WORD_BANK) counts.set(w.category, (counts.get(w.category) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => ({ name, count }));
}

/**
 * `categories` / `difficulty`: si se pasan, acotan el banco a esa temática y
 * ese nivel. Cada filtro cae de vuelta al conjunto anterior si dejaría el
 * banco vacío, para que una combinación sin palabras nunca produzca una
 * partida de cero rondas.
 */
/**
 * Baraja de verdad (Fisher-Yates). El truco de `sort(() => Math.random() - 0.5)`
 * viola el contrato del comparador: reparte sesgado y el resultado depende del
 * motor, así que ciertas palabras salían primero mucho más seguido.
 */
function shuffle<T>(items: readonly T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * `recentWords`: palabras ya usadas en partidas anteriores, ordenadas de la más
 * antigua a la más reciente. Se prefieren SIEMPRE las que no han salido; solo
 * cuando no alcanzan (el pool de una combinación temática+dificultad puede ser
 * de apenas 6-8 palabras) se recicla, y empezando por las más antiguas.
 *
 * Dentro de una misma partida nunca hubo repetidas: el problema real era entre
 * partidas seguidas, donde cada una volvía a consumir el pool completo.
 */
/** Tope duro de rondas por partida. Con el pool efectivo actual (~20 palabras
 *  por temática) permite dos partidas seguidas sin repetir ni una palabra. */
export const MAX_ROUNDS = 8;

/** Dificultades de las que se puede tomar prestado, en orden de cercanía. */
const NEIGHBOUR_DIFFICULTIES: Record<Difficulty, Difficulty[]> = {
  facil:      ['intermedio', 'dificil'],
  intermedio: ['facil', 'dificil'],
  dificil:    ['intermedio', 'facil'],
};

export function getRandomRounds(
  count: number,
  categories?: string[],
  difficulty?: Difficulty,
  recentWords: readonly string[] = [],
): WordEntry[] {
  let pool = WORD_BANK;

  if (categories && categories.length > 0) {
    const byCategory = pool.filter(w => categories.includes(w.category));
    if (byCategory.length > 0) pool = byCategory;
  }

  // La dificultad votada es una PREFERENCIA, no un corte duro. Filtrarla como
  // corte dejaba pools de 6-8 palabras: la partida consumía el pool entero y la
  // siguiente repetía todo. Aquí se ordena el pool por cercanía a lo votado y
  // se deja que la selección de abajo tome prestado solo lo que falte.
  if (difficulty) {
    const byLevel = (d: Difficulty) => pool.filter(w => w.difficulty === d);
    pool = [byLevel(difficulty), ...NEIGHBOUR_DIFFICULTIES[difficulty].map(byLevel)].flat();
  }

  return pickFreshFirst(pool, Math.min(count, MAX_ROUNDS), recentWords);
}

/**
 * Cola para el modo Relajo: sin temática ni dificultad, el banco COMPLETO
 * mezclado. Un modo sin final necesita un pool grande — con las 160 palabras
 * puede correr muchísimo antes de tener que reciclar.
 */
export function getMixedQueue(count: number, recentWords: readonly string[] = []): WordEntry[] {
  return pickFreshFirst(WORD_BANK, count, recentWords);
}

/**
 * Elige `count` palabras priorizando las que NO han salido recientemente; si no
 * alcanzan, recicla empezando por las más antiguas. `pool` debe venir ya
 * ordenado por prioridad (p. ej. dificultad votada primero).
 */
function pickFreshFirst(
  pool: readonly WordEntry[],
  count: number,
  recentWords: readonly string[],
): WordEntry[] {
  const total = Math.min(count, pool.length);

  // índice mayor = usada más recientemente
  const usedAt = new Map<string, number>();
  recentWords.forEach((w, i) => usedAt.set(w, i));

  // Se baraja dentro de cada nivel para no perder la prioridad del pool.
  const nuncaUsadas = shuffleByLevel(pool.filter(w => !usedAt.has(w.word)));
  if (nuncaUsadas.length >= total) return shuffle(nuncaUsadas.slice(0, total));

  const masAntiguasPrimero = pool
    .filter(w => usedAt.has(w.word))
    .sort((a, b) => usedAt.get(a.word)! - usedAt.get(b.word)!);

  return shuffle([...nuncaUsadas, ...masAntiguasPrimero.slice(0, total - nuncaUsadas.length)]);
}

/** Baraja dentro de cada nivel sin alterar el orden entre niveles: así la
 *  dificultad votada sigue saliendo primero, pero no siempre en el mismo orden. */
function shuffleByLevel(words: readonly WordEntry[]): WordEntry[] {
  const groups = new Map<Difficulty, WordEntry[]>();
  for (const w of words) {
    const g = groups.get(w.difficulty);
    if (g) g.push(w); else groups.set(w.difficulty, [w]);
  }
  return [...groups.values()].flatMap(shuffle);
}
