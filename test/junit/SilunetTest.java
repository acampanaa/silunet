import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;

import java.io.IOException;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Pruebas de caja negra del servidor de Silunet.
 *
 * Silunet no tiene código Java, así que aquí no se instancia ninguna clase del
 * sistema: se arranca el servidor de verdad y se le habla desde afuera por HTTP
 * y por WebSocket, igual que lo haría un celular. Eso es lo que estas pruebas
 * comprueban — el contrato público, no el código por dentro.
 *
 * Toda la plomería (arrancar el servidor, abrir sockets) vive en los métodos
 * auxiliares del final, para que cada prueba se lea en dos o tres líneas.
 *
 * Ejecutar con:  npm run test:junit
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@DisplayName("Silunet - servidor Node y contratos públicos")
class SilunetTest {

    // ---------------------------------------------------------------- pruebas

    @Test
    @DisplayName("La pantalla de registro está disponible")
    void pantallaDeRegistroDisponible() throws Exception {
        int codigo = codigoDe("/join");
        assertEquals(200, codigo);
    }

    @Test
    @DisplayName("La pantalla del jugador está disponible")
    void pantallaDelJugadorDisponible() throws Exception {
        int codigo = codigoDe("/play");
        assertEquals(200, codigo);
    }

    @Test
    @DisplayName("La pantalla maestra está disponible")
    void pantallaMaestraDisponible() throws Exception {
        int codigo = codigoDe("/master");
        assertEquals(200, codigo);
    }

    @Test
    @DisplayName("Una ruta que no existe devuelve 404")
    void rutaInexistenteDevuelve404() throws Exception {
        int codigo = codigoDe("/no-existe-junit");
        assertEquals(404, codigo);
    }

    @Test
    @DisplayName("El nodo aislado se declara coordinador")
    void nodoAisladoEsCoordinador() throws Exception {
        String estado = cuerpoDe("/api/info");
        assertTrue(estado.contains("\"isCoordinator\":true"), estado);
    }

    @Test
    @DisplayName("Antes de empezar, la partida está en espera")
    void partidaArrancaEnEspera() throws Exception {
        String estado = cuerpoDe("/api/info");
        assertTrue(estado.contains("\"phase\":\"waiting\""), estado);
    }

    @Test
    @DisplayName("Un jugador que se une recibe su apodo de vuelta")
    void jugadorRecibeSuApodo() throws Exception {
        String bienvenida = responderA("{\"type\":\"JOIN\",\"nick\":\"JugadorJUnit\"}", "WELCOME");
        assertTrue(bienvenida.contains("\"nick\":\"JugadorJUnit\""), bienvenida);
    }

    @Test
    @DisplayName("Un jugador que se une recibe un token para reconectarse")
    void jugadorRecibeUnToken() throws Exception {
        // El token es lo que le permite volver a entrar sin perder su puntaje.
        String bienvenida = responderA("{\"type\":\"JOIN\",\"nick\":\"JugadorJUnit\"}", "WELCOME");
        assertTrue(bienvenida.contains("\"token\":\""), bienvenida);
    }

    @Test
    @DisplayName("Un apodo vacío es rechazado")
    void apodoVacioEsRechazado() throws Exception {
        String error = responderA("{\"type\":\"JOIN\",\"nick\":\"   \"}", "ERROR");
        assertTrue(error.contains("Nick inv"), error);
    }

    // -------------------------------------------------------------- auxiliares

    /** Devuelve el código HTTP de una ruta. */
    private int codigoDe(String ruta) throws Exception {
        return pedir(ruta).statusCode();
    }

    /** Devuelve el cuerpo de una ruta como texto. */
    private String cuerpoDe(String ruta) throws Exception {
        return pedir(ruta).body();
    }

    private HttpResponse<String> pedir(String ruta) throws IOException, InterruptedException {
        HttpRequest peticion = HttpRequest.newBuilder(baseUri.resolve(ruta))
                .timeout(TIMEOUT)
                .GET()
                .build();
        return http.send(peticion, HttpResponse.BodyHandlers.ofString());
    }

    /**
     * Abre un WebSocket, manda un mensaje y devuelve la primera respuesta del
     * tipo esperado. Cierra la conexión al terminar.
     */
    private String responderA(String mensaje, String tipoEsperado) throws Exception {
        Buzon buzon = new Buzon();
        WebSocket socket = http.newWebSocketBuilder()
                .connectTimeout(TIMEOUT)
                .buildAsync(URI.create(baseUri.toString().replaceFirst("^http", "ws")), buzon)
                .join();

        socket.sendText(mensaje, true).join();
        String respuesta = buzon.esperar(m -> m.contains("\"type\":\"" + tipoEsperado + "\""));
        socket.sendClose(WebSocket.NORMAL_CLOSURE, "fin de prueba").join();
        return respuesta;
    }

    // ------------------------------------------------------ montaje del servidor

    private static final Duration TIMEOUT = Duration.ofSeconds(5);
    private static final Duration ARRANQUE = Duration.ofSeconds(20);

    // HTTP/1.1 explícito: por defecto Java negocia HTTP/2 y manda
    // "Upgrade: h2c". El servidor de WebSocket atiende ese upgrade, ve que no
    // es websocket y responde 400.
    private final HttpClient http = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .proxy(HttpClient.Builder.NO_PROXY)
            .connectTimeout(TIMEOUT)
            .build();

    private final Path raiz = Path.of("").toAbsolutePath().normalize();
    private Process servidor;
    private URI baseUri;
    private Path baseDatos;
    private boolean servidorPropio;

    @BeforeAll
    void arrancarSilunet() throws Exception {
        String externo = System.getenv("SILUNET_BASE_URL");
        if (externo != null && !externo.isBlank()) {
            baseUri = URI.create(externo.endsWith("/") ? externo : externo + "/");
            servidorPropio = false;
            esperarQueResponda();
            return;
        }

        Path script = raiz.resolve("dist/server.js");
        assertTrue(Files.isRegularFile(script),
                "Falta dist/server.js. Ejecute 'npm run build' antes de JUnit.");

        int puerto = puertoLibre();
        baseUri = URI.create("http://127.0.0.1:" + puerto + "/");
        String nodeId = "junit-" + ProcessHandle.current().pid();
        baseDatos = raiz.resolve("data/silunet-" + nodeId + ".db");
        servidorPropio = true;
        borrarBaseDeDatos();

        Path reportes = raiz.resolve("reports/junit");
        Files.createDirectories(reportes);

        ProcessBuilder constructor = new ProcessBuilder("node", "dist/server.js");
        constructor.directory(raiz.toFile());
        constructor.redirectErrorStream(true);
        constructor.redirectOutput(reportes.resolve("server.log").toFile());
        constructor.environment().put("NODE_ID", nodeId);
        constructor.environment().put("PORT", Integer.toString(puerto));
        constructor.environment().put("COORDINATOR_ID", nodeId);
        constructor.environment().put("PEERS", "");
        constructor.environment().put("DATABASE_URL", ""); // sqlite aislado, no la BD real
        servidor = constructor.start();

        esperarQueResponda();
    }

    @AfterAll
    void detenerSilunet() throws Exception {
        if (servidorPropio && servidor != null && servidor.isAlive()) {
            servidor.destroy();
            if (!servidor.waitFor(3, TimeUnit.SECONDS)) {
                servidor.destroyForcibly();
                servidor.waitFor(3, TimeUnit.SECONDS);
            }
        }
        if (servidorPropio) borrarBaseDeDatos();
    }

    private void esperarQueResponda() throws Exception {
        long limite = System.nanoTime() + ARRANQUE.toNanos();
        String ultimoFallo = "sin intentos";
        while (System.nanoTime() < limite) {
            if (servidorPropio && servidor != null && !servidor.isAlive()) {
                throw new IllegalStateException(
                        "El servidor Node murió al arrancar. Vea reports/junit/server.log");
            }
            try {
                if (codigoDe("/api/info") == 200) return;
                ultimoFallo = "HTTP " + codigoDe("/api/info");
            } catch (Exception error) {
                ultimoFallo = error.getClass().getSimpleName() + ": " + error.getMessage();
            }
            Thread.sleep(200);
        }
        throw new IllegalStateException("Silunet no respondió a tiempo — último fallo: " + ultimoFallo);
    }

    private static int puertoLibre() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    private void borrarBaseDeDatos() throws IOException {
        if (baseDatos == null) return;
        for (String sufijo : List.of("", "-shm", "-wal", "-journal")) {
            Files.deleteIfExists(Path.of(baseDatos + sufijo));
        }
    }

    /** Guarda los mensajes que llegan por WebSocket para poder esperarlos. */
    private static final class Buzon implements WebSocket.Listener {
        private final BlockingQueue<String> mensajes = new LinkedBlockingQueue<>();
        private final StringBuilder parcial = new StringBuilder();

        @Override
        public void onOpen(WebSocket socket) {
            socket.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket socket, CharSequence datos, boolean ultimo) {
            parcial.append(datos);
            if (ultimo) {
                mensajes.offer(parcial.toString());
                parcial.setLength(0);
            }
            socket.request(1);
            return null;
        }

        String esperar(Predicate<String> condicion) throws InterruptedException {
            long limite = System.nanoTime() + TIMEOUT.toNanos();
            while (System.nanoTime() < limite) {
                String mensaje = mensajes.poll(200, TimeUnit.MILLISECONDS);
                if (mensaje != null && condicion.test(mensaje)) return mensaje;
            }
            throw new AssertionError("No llegó el mensaje esperado por WebSocket");
        }
    }
}
