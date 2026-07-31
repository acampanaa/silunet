-- ============================================================================
-- Silunet — esquema PostgreSQL compartido
-- ============================================================================
-- Los tres nodos usan la MISMA DATABASE_URL. El estado vivo continúa en
-- memoria y se replica por WebSocket; aquí solo se guardan identidades e
-- historia confirmada. src/postgres.ts ejecuta esta migración al arrancar.

BEGIN;

CREATE TABLE IF NOT EXISTS jugadores (
    token      UUID        PRIMARY KEY,
    nick       TEXT        NOT NULL CHECK (char_length(nick) BETWEEN 1 AND 20),
    avatar_id  SMALLINT    NOT NULL DEFAULT 0 CHECK (avatar_id BETWEEN 0 AND 11),
    avatar_key UUID        UNIQUE,
    avatar_mime TEXT       CONSTRAINT jugadores_avatar_mime_check
                           CHECK (avatar_mime IS NULL OR avatar_mime = 'image/jpeg'),
    avatar_data BYTEA      CONSTRAINT jugadores_avatar_data_size_check
                           CHECK (avatar_data IS NULL OR octet_length(avatar_data) <= 204800),
    creado_en  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Migración idempotente para bases creadas antes de admitir fotos personales.
ALTER TABLE jugadores ADD COLUMN IF NOT EXISTS avatar_key UUID UNIQUE;
ALTER TABLE jugadores ADD COLUMN IF NOT EXISTS avatar_mime TEXT;
ALTER TABLE jugadores ADD COLUMN IF NOT EXISTS avatar_data BYTEA;

DO $$ BEGIN
  ALTER TABLE jugadores ADD CONSTRAINT jugadores_avatar_mime_check
    CHECK (avatar_mime IS NULL OR avatar_mime = 'image/jpeg');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE jugadores ADD CONSTRAINT jugadores_avatar_data_size_check
    CHECK (avatar_data IS NULL OR octet_length(avatar_data) <= 204800);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS partidas (
    id            UUID        PRIMARY KEY,
    numero        BIGINT      GENERATED ALWAYS AS IDENTITY UNIQUE,
    nombre        TEXT        NOT NULL,
    total_rondas  INTEGER     NOT NULL CHECK (total_rondas > 0),
    jugada_en     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS participaciones (
    partida_id     UUID     NOT NULL REFERENCES partidas(id) ON DELETE CASCADE,
    jugador_token  UUID     NOT NULL REFERENCES jugadores(token) ON DELETE RESTRICT,
    puntos         INTEGER  NOT NULL CHECK (puntos >= 0),
    puesto         INTEGER  NOT NULL CHECK (puesto > 0),
    medalla        TEXT     CHECK (medalla IS NULL OR medalla IN ('oro', 'plata', 'bronce')),
    PRIMARY KEY (partida_id, jugador_token),
    UNIQUE (partida_id, puesto)
);

-- Postgres no crea índices automáticamente para las columnas FK. La PK ya
-- cubre partida_id como primera columna; este índice cubre perfil e historial.
CREATE INDEX IF NOT EXISTS participaciones_jugador_token_idx
    ON participaciones (jugador_token, partida_id);

CREATE INDEX IF NOT EXISTS partidas_jugada_en_idx
    ON partidas (jugada_en DESC);

CREATE INDEX IF NOT EXISTS participaciones_puntos_idx
    ON participaciones (puntos DESC);

-- Fencing/lease: evita que dos coordinadores escriban simultáneamente durante
-- una partición de red. Cada transacción de escritura bloquea y valida esta fila.
CREATE TABLE IF NOT EXISTS cluster_leader (
    cluster_id   TEXT        PRIMARY KEY,
    node_id      TEXT        NOT NULL,
    term         BIGINT      NOT NULL DEFAULT 0 CHECK (term >= 0),
    lease_until  TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

COMMIT;

-- Rol recomendado para producción (ejecutar como administrador y adaptar el
-- nombre si corresponde). La aplicación no necesita DELETE ni TRUNCATE:
--
--   CREATE ROLE silunet_app LOGIN PASSWORD 'CAMBIAR_EN_EL_GESTOR_DE_SECRETOS';
--   GRANT USAGE ON SCHEMA public TO silunet_app;
--   GRANT SELECT, INSERT, UPDATE ON jugadores, partidas,
--       participaciones, cluster_leader TO silunet_app;
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO silunet_app;
