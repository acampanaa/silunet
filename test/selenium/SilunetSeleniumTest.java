import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.openqa.selenium.By;
import org.openqa.selenium.Dimension;
import org.openqa.selenium.JavascriptExecutor;
import org.openqa.selenium.OutputType;
import org.openqa.selenium.TakesScreenshot;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.interactions.Actions;
import org.openqa.selenium.remote.RemoteWebDriver;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeOptions;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.WebDriverWait;

import java.io.File;
import java.io.IOException;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Pruebas funcionales de Silunet con Java, JUnit 5 y Selenium. */
@Tag("selenium")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
public class SilunetSeleniumTest {

    private static WebDriver driver;
    private static WebDriverWait wait;

    // Servidor bajo prueba
    private static Process servidor;
    private static String urlBase;
    private static String nodeId;
    private static Path baseDatos;
    private static final Path RAIZ = Path.of("").toAbsolutePath().normalize();

    // Carpeta donde se guardan las capturas de pantalla
    private static final String CARPETA_CAPTURAS = "reports/selenium";

    // Apodo compartido por los ejercicios 2, 3 y 4
    private static final String APODO = "Selenium" + System.currentTimeMillis() % 1000000;
    private static final String APODO_NUEVO = APODO + "OK";

    // ---------------------------------------------------------------- montaje

    @BeforeAll
    static void iniciar() throws Exception {
        Files.createDirectories(Paths.get(CARPETA_CAPTURAS));
        arrancarSilunet();

        driver = crearNavegador();
        wait = new WebDriverWait(driver, Duration.ofSeconds(15));
    }

    // Abre Chrome local o Selenium Grid si se define SELENIUM_REMOTE_URL
    private static WebDriver crearNavegador() throws Exception {
        ChromeOptions opciones = new ChromeOptions();
        opciones.addArguments("--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox",
                "--window-size=1440,1000");
        // -DseleniumHeadless=false para ver el navegador durante la prueba
        if (!"false".equalsIgnoreCase(System.getProperty("seleniumHeadless", "true"))) {
            opciones.addArguments("--headless=new");
        }

        String grid = System.getenv("SELENIUM_REMOTE_URL");
        if (grid != null && !grid.isBlank()) {
            return new RemoteWebDriver(URI.create(grid).toURL(), opciones);
        }
        return new ChromeDriver(opciones);
    }

    @AfterAll
    static void cerrar() throws Exception {
        if (driver != null) driver.quit();
        if (servidor != null && servidor.isAlive()) {
            servidor.destroy();
            if (!servidor.waitFor(3, TimeUnit.SECONDS)) servidor.destroyForcibly();
        }
        borrarBaseDeDatos();
    }

    // Levanta un servidor aislado o usa SILUNET_BASE_URL si esta definido
    private static void arrancarSilunet() throws Exception {
        String externo = System.getenv("SILUNET_BASE_URL");
        if (externo != null && !externo.isBlank()) {
            urlBase = externo.endsWith("/") ? externo.substring(0, externo.length() - 1) : externo;
            esperarQueResponda();
            return;
        }

        Path script = RAIZ.resolve("dist/server.js");
        assertTrue(Files.isRegularFile(script),
                "Falta dist/server.js. Ejecute 'npm run build' antes de Selenium.");

        int puerto = puertoLibre();
        urlBase = "http://127.0.0.1:" + puerto;
        nodeId = "selenium-" + ProcessHandle.current().pid();
        baseDatos = RAIZ.resolve("data/silunet-" + nodeId + ".db");
        borrarBaseDeDatos();

        ProcessBuilder constructor = new ProcessBuilder("node", "dist/server.js");
        constructor.directory(RAIZ.toFile());
        constructor.redirectErrorStream(true);
        constructor.redirectOutput(Paths.get(CARPETA_CAPTURAS, "server.log").toFile());
        constructor.environment().put("NODE_ID", nodeId);
        constructor.environment().put("PORT", Integer.toString(puerto));
        constructor.environment().put("COORDINATOR_ID", nodeId);
        constructor.environment().put("PEERS", "");
        constructor.environment().put("DATABASE_URL", ""); // sqlite aislado, no la BD real
        servidor = constructor.start();

        esperarQueResponda();
    }

    private static int puertoLibre() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    private static void esperarQueResponda() throws Exception {
        // Silunet necesita HTTP/1.1 para no confundir la sonda con un WebSocket
        HttpClient http = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .proxy(HttpClient.Builder.NO_PROXY)
                .connectTimeout(Duration.ofSeconds(2))
                .build();
        HttpRequest sonda = HttpRequest.newBuilder(URI.create(urlBase + "/api/info"))
                .timeout(Duration.ofSeconds(2)).GET().build();

        String ultimoFallo = "sin intentos";
        long limite = System.currentTimeMillis() + 30000;
        while (System.currentTimeMillis() < limite) {
            if (servidor != null && !servidor.isAlive()) {
                throw new IllegalStateException("El servidor murio al arrancar (codigo "
                        + servidor.exitValue() + "). Vea " + CARPETA_CAPTURAS + "/server.log");
            }
            try {
                HttpResponse<String> r = http.send(sonda, HttpResponse.BodyHandlers.ofString());
                if (r.statusCode() == 200) return;
                ultimoFallo = "HTTP " + r.statusCode();
            } catch (Exception error) {
                ultimoFallo = error.getClass().getSimpleName() + ": " + error.getMessage();
            }
            Thread.sleep(250);
        }
        throw new IllegalStateException(
                "Silunet no respondio en " + urlBase + " — ultimo fallo: " + ultimoFallo);
    }

    private static void borrarBaseDeDatos() {
        if (baseDatos == null) return;
        for (String sufijo : List.of("", "-shm", "-wal", "-journal")) {
            try {
                Files.deleteIfExists(Path.of(baseDatos + sufijo));
            } catch (IOException ignorada) {
                // no existia
            }
        }
    }

    // ------------------------------------------------------------- auxiliares

    /** Metodo auxiliar para tomar una captura de pantalla y guardarla en la carpeta */
    private void capturar(String nombre) throws Exception {
        capturar(nombre, driver);
    }

    private void capturar(String nombre, WebDriver navegador) throws Exception {
        File origen = ((TakesScreenshot) navegador).getScreenshotAs(OutputType.FILE);
        Path destino = Paths.get(CARPETA_CAPTURAS, nombre + ".png");
        Files.copy(origen.toPath(), destino, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        System.out.println("Captura guardada en: " + destino.toAbsolutePath());
    }

    // Da tiempo a que termine la animacion y guarda la evidencia
    private void esperarYCapturar(String nombre) throws Exception {
        esperarYCapturar(nombre, driver);
    }

    private void esperarYCapturar(String nombre, WebDriver navegador) throws Exception {
        Thread.sleep(1000);
        capturar(nombre, navegador);
    }

    // Cierra el selector para que no tape la captura; no afecta la validacion
    private void cerrarSelectorDeModos(WebDriver navegador) {
        try {
            ((JavascriptExecutor) navegador).executeScript("document.activeElement?.blur();");
            new Actions(navegador).moveToLocation(5, 5).perform();
            new WebDriverWait(navegador, Duration.ofSeconds(5)).until(
                    web -> (Boolean) ((JavascriptExecutor) web).executeScript(
                            "return !document.getElementById('mode-picker')"
                                    + "  .matches(':hover, :focus-within, .open');"));
        } catch (Exception error) {
            System.out.println("Aviso: no se pudo cerrar el selector: "
                    + error.getClass().getSimpleName());
        }
    }

    /** Borra el token guardado: obliga a la pantalla de registro como un celular nuevo. */
    private void limpiarIdentidad() {
        // /join redirige a /play si reconoce al usuario. Limpiamos primero
        // desde /master, que comparte el mismo localStorage y no redirige.
        driver.get(urlBase + "/master");
        ((JavascriptExecutor) driver).executeScript("localStorage.clear(); sessionStorage.clear();");
        driver.get(urlBase + "/join");
    }

    private String enLocalStorage(String clave) {
        return (String) ((JavascriptExecutor) driver)
                .executeScript("return localStorage.getItem(arguments[0]);", clave);
    }

    private void unirseComo(String apodo) throws InterruptedException {
        limpiarIdentidad();
        WebElement campo = wait.until(ExpectedConditions.visibilityOfElementLocated(By.id("nick")));
        campo.clear();
        campo.sendKeys(apodo);
        Thread.sleep(500);
        driver.findElement(By.cssSelector("button[onclick=\"join()\"]")).click();
        wait.until(ExpectedConditions.urlContains("/play"));
        wait.until(ExpectedConditions.visibilityOfElementLocated(By.cssSelector("#s-waiting.active")));
        wait.until(ExpectedConditions.textMatches(By.id("w-greet"), java.util.regex.Pattern.compile(apodo)));
    }

    // -------------------------------------------------------------- ejercicios

    // Ejercicio 1 el apodo es obligatorio
    @Test
    @Order(1)
    public void apodoObligatorio() throws Exception {
        limpiarIdentidad();
        driver.findElement(By.cssSelector("button[onclick=\"join()\"]")).click();

        WebElement error = wait.until(
                ExpectedConditions.visibilityOfElementLocated(By.id("err"))
        );
        esperarYCapturar("ejercicio1_apodo_obligatorio");
        assertTrue(error.getText().contains("Escribe tu apodo"),
                "Se esperaba el aviso de apodo obligatorio, salio: " + error.getText());
        assertTrue(driver.getCurrentUrl().contains("/join"),
                "Sin apodo no deberia salir de /join");
    }

    // Ejercicio 2 registro inicial: el celular guarda su identidad
    @Test
    @Order(2)
    public void registroInicial() throws Exception {
        unirseComo(APODO);
        esperarYCapturar("ejercicio2_registro_inicial");

        assertNotNull(enLocalStorage("silunet_token"),
                "El celular deberia guardar un token para poder reconectarse");
        assertEquals(APODO, enLocalStorage("silunet_nick"));
        assertTrue(driver.findElement(By.id("w-greet")).getText().contains(APODO));
    }

    // Ejercicio 3 identidad recurrente: volver a /join no vuelve a pedir el apodo
    @Test
    @Order(3)
    public void identidadRecurrente() throws Exception {
        driver.get(urlBase + "/join");
        wait.until(ExpectedConditions.urlContains("/play"));

        wait.until(ExpectedConditions.textMatches(
                By.id("w-greet"), java.util.regex.Pattern.compile("Bienvenido de vuelta")));
        WebElement saludo = driver.findElement(By.id("w-greet"));
        WebElement cambiarNombre = wait.until(
                ExpectedConditions.visibilityOfElementLocated(By.id("w-change-name"))
        );
        esperarYCapturar("ejercicio3_usuario_recurrente");

        assertTrue(saludo.getText().contains("Bienvenido de vuelta"));
        assertTrue(cambiarNombre.isDisplayed(), "Deberia ofrecer cambiar el nombre");
    }

    // Ejercicio 4 cambiar el nombre desde el perfil
    @Test
    @Order(4)
    public void cambioDeNombre() throws Exception {
        driver.findElement(By.id("w-change-name")).click();

        WebElement campo = wait.until(
                ExpectedConditions.visibilityOfElementLocated(By.id("pf-nick-input"))
        );
        campo.clear();
        campo.sendKeys(APODO_NUEVO);
        Thread.sleep(500);
        driver.findElement(By.id("pf-name-save")).click();

        wait.until(ExpectedConditions.textMatches(
                By.id("pf-name-status"), java.util.regex.Pattern.compile("Nombre actualizado")));
        esperarYCapturar("ejercicio4_cambio_de_nombre");

        assertEquals(APODO_NUEVO, driver.findElement(By.id("profile-title")).getText());
        assertEquals(APODO_NUEVO, enLocalStorage("silunet_nick"),
                "El nombre nuevo tambien deberia quedar guardado en el celular");
    }

    // Ejercicio 5 la pantalla maestra ofrece los tres modos de juego
    @Test
    @Order(5)
    public void selectorDeModosEnEscritorio() throws Exception {
        driver.manage().window().setSize(new Dimension(1440, 1000));
        driver.get(urlBase + "/master");

        WebElement disparador = wait.until(
                ExpectedConditions.elementToBeClickable(By.id("mode-picker-trigger"))
        );
        disparador.click();
        wait.until(ExpectedConditions.attributeToBe(
                By.id("mode-picker-trigger"), "aria-expanded", "true"));
        esperarYCapturar("ejercicio5_modos_escritorio");

        List<WebElement> tarjetas = driver.findElements(By.cssSelector(".mode-card"));
        assertEquals(3, tarjetas.size(), "Silunet tiene tres modos: Clasico, Relajo y SiluStack");
    }

    // Ejercicio 6 el selector no se desborda en un celular
    @Test
    @Order(6)
    public void selectorDeModosEnMovil() throws Exception {
        driver.manage().window().setSize(new Dimension(390, 844));
        driver.get(urlBase + "/master");
        wait.until(ExpectedConditions.elementToBeClickable(By.id("mode-picker-trigger"))).click();
        wait.until(navegador -> (Boolean) ((JavascriptExecutor) navegador).executeScript(
                "const c = document.getElementById('mode-deck').getBoundingClientRect();"
                        + "return c.left >= -1 && c.right <= window.innerWidth + 1;"));
        ((JavascriptExecutor) driver).executeScript("window.scrollTo(0, 0);");
        esperarYCapturar("ejercicio6_modos_movil");

        // Ningun elemento debe sobresalir del ancho de la pantalla
        @SuppressWarnings("unchecked")
        List<String> desbordados = (List<String>) ((JavascriptExecutor) driver).executeScript(
                "const ancho = window.innerWidth;"
                        + "return [...document.querySelectorAll('body *')]"
                        + "  .filter(e => { const c = e.getBoundingClientRect();"
                        + "                 return c.left < -1 || c.right > ancho + 1; })"
                        + "  .slice(0, 8)"
                        + "  .map(e => e.id ? '#' + e.id : e.tagName.toLowerCase());");
        assertTrue(desbordados.isEmpty(), "Hay elementos fuera de la vista movil: " + desbordados);

        driver.manage().window().setSize(new Dimension(1440, 1000));
    }

    // Ejercicio 7 una partida real: la maestra inicia SiluStack y el celular
    // recibe su propio tablero. Hacen falta DOS navegadores porque son dos
    // pantallas distintas del mismo sistema.
    @Test
    @Order(7)
    public void partidaSiluStackConDosPantallas() throws Exception {
        unirseComo("Stack" + System.currentTimeMillis() % 100000);

        WebDriver maestra = crearNavegador();

        try {
            WebDriverWait esperaMaestra = new WebDriverWait(maestra, Duration.ofSeconds(20));
            maestra.get(urlBase + "/master");

            // La maestra ve al celular que ya se unio: eso ya prueba el WebSocket
            esperaMaestra.until(ExpectedConditions.textMatches(
                    By.id("m-count"), java.util.regex.Pattern.compile("1 jugador")));

            maestra.findElement(By.id("mode-picker-trigger")).click();
            WebElement iniciar = esperaMaestra.until(
                    ExpectedConditions.elementToBeClickable(By.id("btn-stack"))
            );
            iniciar.click();

            esperaMaestra.until(navegador -> !"none".equals(
                    navegador.findElement(By.id("main-stack")).getCssValue("display")));
            esperaMaestra.until(ExpectedConditions.visibilityOfElementLocated(
                    By.cssSelector("#ss-arena .stack-player-card")));

            cerrarSelectorDeModos(maestra);
            esperarYCapturar("ejercicio7_silustack_maestra", maestra);

            assertTrue(maestra.findElement(By.id("ss-survivors")).getText().matches("(?i).*1\\s*/\\s*1 activos.*"),
                    "La maestra deberia contar 1 jugador activo, dice: "
                            + maestra.findElement(By.id("ss-survivors")).getText());

            // Y el celular tuvo que recibir su tablero por WebSocket
            wait.until(navegador -> (Boolean) ((JavascriptExecutor) navegador).executeScript(
                    "const celdas = currentStackState?.width * currentStackState?.height;"
                            + "return document.getElementById('p-stack').classList.contains('show')"
                            + "  && celdas > 0"
                            + "  && document.getElementById('p-stack-grid').childElementCount === celdas;"));
            Thread.sleep(1000);
            capturar("ejercicio7_silustack_jugador");

            Long esperadas = (Long) ((JavascriptExecutor) driver).executeScript(
                    "return currentStackState.width * currentStackState.height;");
            Long dibujadas = (Long) ((JavascriptExecutor) driver).executeScript(
                    "return document.getElementById('p-stack-grid').childElementCount;");
            assertEquals(esperadas, dibujadas, "El tablero del celular quedo incompleto");
        } finally {
            maestra.quit();
        }
    }
}
