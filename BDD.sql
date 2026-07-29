-- ============================================================================
--  Silunet — Esquema de base de datos
--  PUCE Sede Manabí · Ingeniería de Software
-- ============================================================================
--
--  Motor: SQLite (a través de `node:sqlite`, el módulo SQLite integrado de
--  Node.js 22+). No requiere instalar ni levantar ningún servidor de base de
--  datos: el archivo se crea solo en data/silunet-<NODE_ID>.db al arrancar.
--
--  Este script es la referencia documental del esquema. La aplicación lo aplica
--  sola en src/db.ts (método migrate(), idempotente con IF NOT EXISTS), así que
--  NO hace falta ejecutarlo a mano para que el sistema funcione. Se incluye para
--  poder inspeccionar, recrear o auditar la estructura de forma independiente.
--
--  Para crear la base manualmente (opcional, requiere el CLI de sqlite3):
--      sqlite3 data/silunet-node1.db < BDD.sql
--
-- ----------------------------------------------------------------------------
--  ALCANCE: aquí solo vive HISTORIA YA CERRADA (identidad de jugadores y
--  resultados de partidas terminadas). El estado vivo de la partida —ronda
--  actual, letras reveladas, marcador en juego, coordinación entre nodos— vive
--  EN MEMORIA y se replica entre los nodos del clúster; nunca pasa por aquí.
--
--  REGLA DISTRIBUIDA: solo el nodo COORDINADOR electo escribe en esta base. Así
--  la persistencia depende de la elección de líder (Eje 4) en lugar de competir
--  con ella. Cada nodo tiene su propio archivo, listo para cuando sea promovido.
-- ============================================================================

PRAGMA journal_mode = WAL;   -- escrituras rápidas y seguras
PRAGMA foreign_keys = ON;


-- ----------------------------------------------------------------------------
--  jugadores — identidad persistente de cada celular
-- ----------------------------------------------------------------------------
--  El `token` es un UUID que el servidor genera la primera vez y que el celular
--  guarda en su propio localStorage. Es lo que permite reconocer a un jugador
--  que vuelve en otra partida ("¡Hola de nuevo!") sin pedirle registrarse, y lo
--  que le devuelve su puntaje si se reconecta a mitad de partida por otro nodo.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jugadores (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    token     TEXT    UNIQUE NOT NULL,   -- UUID guardado en el celular
    nick      TEXT    NOT NULL,          -- apodo elegido (se puede cambiar)
    creado_en TEXT    NOT NULL,          -- ISO 8601, primera vez que jugó
    -- Índice del avatar elegido en /join (ver public/avatars.js).
    -- En src/db.ts se agrega como ALTER separado para no romper bases
    -- que ya existían antes de la función de avatares.
    avatar_id INTEGER NOT NULL DEFAULT 0
);


-- ----------------------------------------------------------------------------
--  partidas — cada partida terminada
-- ----------------------------------------------------------------------------
--  Se inserta una fila cuando la partida CIERRA (no al empezar): si el
--  coordinador cae a mitad de juego, no queda basura registrada.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS partidas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre       TEXT    NOT NULL,       -- ej. "Casa Abierta #3"
    total_rondas INTEGER NOT NULL,       -- rondas efectivamente jugadas
    jugada_en    TEXT    NOT NULL        -- ISO 8601
);


-- ----------------------------------------------------------------------------
--  participaciones — resultado de un jugador en una partida (tabla puente)
-- ----------------------------------------------------------------------------
--  Relación N:M entre jugadores y partidas. El UNIQUE evita doble registro si
--  el mismo cierre de partida se procesara dos veces (p.ej. por un failover
--  justo en ese instante).
--
--  Las estadísticas agregadas (partidas ganadas, puntos totales, medallero) NO
--  se almacenan: se CALCULAN con consultas sobre esta tabla, así nunca quedan
--  desincronizadas con los datos reales.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS participaciones (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    jugador_id INTEGER NOT NULL REFERENCES jugadores(id),
    partida_id INTEGER NOT NULL REFERENCES partidas(id),
    puntos     INTEGER NOT NULL,         -- puntos obtenidos en esa partida
    puesto     INTEGER NOT NULL,         -- 1 = ganó la partida
    medalla    TEXT,                     -- 'oro' | 'plata' | 'bronce' | NULL
    UNIQUE (jugador_id, partida_id)
);


-- ============================================================================
--  CONSULTAS DE REFERENCIA
--  Las que la aplicación usa de verdad (ver src/db.ts). Se documentan aquí para
--  poder verificar el modelo de datos sin leer el código TypeScript.
-- ============================================================================

-- Perfil individual de un jugador (lo que ve al abrir su perfil en el celular).
-- Todo agregado, nada almacenado:
--
--   SELECT COUNT(*)                                                   AS jugadas,
--          COALESCE(SUM(CASE WHEN puesto = 1 THEN 1 ELSE 0 END), 0)   AS ganadas,
--          COALESCE(SUM(puntos), 0)                                   AS puntos,
--          COALESCE(SUM(CASE WHEN medalla = 'oro'    THEN 1 ELSE 0 END), 0) AS oro,
--          COALESCE(SUM(CASE WHEN medalla = 'plata'  THEN 1 ELSE 0 END), 0) AS plata,
--          COALESCE(SUM(CASE WHEN medalla = 'bronce' THEN 1 ELSE 0 END), 0) AS bronce
--     FROM participaciones
--    WHERE jugador_id = ?;

-- Salón de la fama: ranking histórico acumulado de todas las Casa Abierta.
--
--   SELECT j.nick,
--          COUNT(*)                    AS partidasJugadas,
--          COALESCE(SUM(pt.puntos), 0) AS puntosAcumulados
--     FROM participaciones pt
--     JOIN jugadores j ON j.id = pt.jugador_id
--    GROUP BY pt.jugador_id
--    ORDER BY puntosAcumulados DESC
--    LIMIT 10;

-- Últimas partidas con su ganador.
--
--   SELECT pa.nombre, pa.jugada_en, pa.total_rondas,
--          (SELECT j.nick FROM participaciones pt
--             JOIN jugadores j ON j.id = pt.jugador_id
--            WHERE pt.partida_id = pa.id AND pt.puesto = 1 LIMIT 1) AS ganador
--     FROM partidas pa
--    ORDER BY pa.id DESC
--    LIMIT 6;
