import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.openqa.selenium.By;
import org.openqa.selenium.JavascriptExecutor;
import org.openqa.selenium.Keys;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeOptions;
import org.openqa.selenium.support.ui.WebDriverWait;

import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Prueba de fuego: el único servidor desaparece y los navegadores ya
 * conectados terminan la ronda por WebRTC, sin HTTP ni WebSocket central.
 */
@Tag("selenium")
public class P2PFireTest {
    private static final Path ROOT = Path.of("").toAbsolutePath().normalize();
    private static final Path REPORTS = ROOT.resolve("reports/p2p-fire");
    private static Process server;
    private static WebDriver playerA;
    private static WebDriver playerB;
    private static WebDriver master;
    private static String baseUrl;
    private static Path database;

    @BeforeAll
    static void setup() throws Exception {
        Files.createDirectories(REPORTS);
        int port = freePort();
        String nodeId = "p2p-fire-" + ProcessHandle.current().pid();
        database = ROOT.resolve("data/silunet-" + nodeId + ".db");
        deleteDatabase();

        ProcessBuilder builder = new ProcessBuilder("node", "dist/server.js");
        builder.directory(ROOT.toFile());
        builder.redirectErrorStream(true);
        builder.redirectOutput(REPORTS.resolve("server.log").toFile());
        builder.environment().put("NODE_ID", nodeId);
        builder.environment().put("PORT", Integer.toString(port));
        builder.environment().put("COORDINATOR_ID", nodeId);
        builder.environment().put("PEERS", "");
        builder.environment().remove("DATABASE_URL");
        server = builder.start();
        baseUrl = "http://127.0.0.1:" + port;
        waitForServer();

        playerA = browser();
        playerB = browser();
        master = browser();
        joinDirectly(playerA, "FuegoA");
        joinDirectly(playerB, "FuegoB");
        master.get(baseUrl + "/master");
    }

    @AfterAll
    static void teardown() throws Exception {
        if (playerA != null) playerA.quit();
        if (playerB != null) playerB.quit();
        if (master != null) master.quit();
        if (server != null && server.isAlive()) {
            server.destroyForcibly();
            server.waitFor(3, TimeUnit.SECONDS);
        }
        deleteDatabase();
    }

    @Test
    void browsersContinueAfterOnlyServerDies() throws Exception {
        WebDriverWait waitA = new WebDriverWait(playerA, Duration.ofSeconds(25));
        WebDriverWait waitB = new WebDriverWait(playerB, Duration.ofSeconds(25));
        waitA.until(driver -> p2pOpenPlayerPeers(driver) >= 1);
        waitB.until(driver -> p2pOpenPlayerPeers(driver) >= 1);

        ((JavascriptExecutor) master).executeScript("startGame('clasico');");
        ((JavascriptExecutor) playerA).executeScript(
                "send({type:'CAST_VOTE',kind:'category',option:'Computadores'});"
        );
        ((JavascriptExecutor) playerB).executeScript(
                "send({type:'CAST_VOTE',kind:'category',option:'Computadores'});"
        );
        waitA.until(driver -> "playing".equals(p2pPhase(driver)));
        waitB.until(driver -> "playing".equals(p2pPhase(driver)));
        waitA.until(P2PFireTest::p2pAssetsReady);
        waitB.until(P2PFireTest::p2pAssetsReady);
        assertTrue(p2pCachedAssetCount(playerA) > 0, "La partida no precargo ninguna imagen PNG");
        assertTrue(p2pCachedAssetCount(playerB) > 0, "El segundo jugador no tiene imagenes offline");

        // La maestra representa la pantalla de la laptop anfitriona: también
        // desaparece. Solo quedan los dos celulares y su canal directo.
        master.quit();
        master = null;
        waitA.until(driver -> p2pOpenPlayerPeers(driver) >= 1);
        waitB.until(driver -> p2pOpenPlayerPeers(driver) >= 1);

        long roundBefore = p2pRoundIndex(playerA);
        long timeBefore = p2pTime(playerA);
        assertTrue(timeBefore > 0, "La ronda debía estar corriendo antes de la caída");

        ((JavascriptExecutor) playerA).executeScript("window.__silunetSocket.onclose = function(){};");
        ((JavascriptExecutor) playerB).executeScript("window.__silunetSocket.onclose = function(){};");
        server.destroyForcibly();
        assertTrue(server.waitFor(5, TimeUnit.SECONDS), "El servidor único no terminó");

        waitA.until(driver -> p2pFailover(driver));
        waitB.until(driver -> p2pFailover(driver));
        String leaderA = p2pLeader(playerA);
        String leaderB = p2pLeader(playerB);
        assertNotNull(leaderA, "No se eligió líder P2P");
        assertEquals(leaderA, leaderB, "Los jugadores eligieron líderes diferentes");

        waitA.until(driver -> p2pTime(driver) < timeBefore);
        long continuedTime = p2pTime(playerA);
        assertTrue(continuedTime >= 0, "El reloj P2P quedó inválido");

        String answer = (String) ((JavascriptExecutor) playerA)
                .executeScript("return window.__silunetP2P.state.round.wordEntry.word;");
        assertNotNull(answer);
        playerA.findElement(By.id("p-input")).sendKeys(answer, Keys.ENTER);

        waitA.until(driver -> p2pSolverCount(driver) >= 1);
        waitB.until(driver -> p2pSolverCount(driver) >= 1);

        new WebDriverWait(playerA, Duration.ofSeconds(50))
                .until(driver -> p2pRoundIndex(driver) > roundBefore);
        assertTrue(!server.isAlive(), "La siguiente ronda no puede depender del servidor muerto");
        assertTrue(p2pTime(playerA) > 0, "La nueva ronda P2P no arrancó su reloj");
    }

    private static WebDriver browser() {
        ChromeOptions options = new ChromeOptions();
        options.addArguments(
                "--headless=new",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no-sandbox",
                "--window-size=1280,900"
        );
        return new ChromeDriver(options);
    }

    private static void joinDirectly(WebDriver driver, String nick) {
        driver.get(baseUrl + "/master");
        ((JavascriptExecutor) driver).executeScript(
                "localStorage.clear(); sessionStorage.clear();"
                        + "sessionStorage.setItem('silunet_nick', arguments[0]);",
                nick
        );
        driver.get(baseUrl + "/play");
        new WebDriverWait(driver, Duration.ofSeconds(20)).until(web ->
                ((JavascriptExecutor) web).executeScript(
                        "return !!window.__silunetP2P && !!window.__silunetP2P.playerId;"
                ).equals(Boolean.TRUE)
        );
    }

    private static long p2pOpenPlayerPeers(WebDriver driver) {
        Object value = ((JavascriptExecutor) driver).executeScript(
                "return [...window.__silunetP2P.peers.entries()].filter(([id,p]) => "
                        + "window.__silunetP2P.known.get(id)?.role === 'player' && p.dc?.readyState === 'open').length;"
        );
        return ((Number) value).longValue();
    }

    private static boolean p2pAssetsReady(WebDriver driver) {
        return Boolean.TRUE.equals(((JavascriptExecutor) driver).executeScript(
                "return window.__silunetP2P?.offlineAssetsReady === true;"
        ));
    }

    private static long p2pCachedAssetCount(WebDriver driver) {
        Object value = ((JavascriptExecutor) driver).executeScript(
                "return [...(window.__silunetP2P?.assetCache?.values() || [])]"
                        + ".filter(value => String(value).startsWith('data:')).length;"
        );
        return ((Number) value).longValue();
    }

    private static boolean p2pFailover(WebDriver driver) {
        return Boolean.TRUE.equals(((JavascriptExecutor) driver)
                .executeScript("return window.__silunetP2P?.failoverActive === true;"));
    }

    private static String p2pLeader(WebDriver driver) {
        return (String) ((JavascriptExecutor) driver)
                .executeScript("return window.__silunetP2P?.leaderId || null;");
    }

    private static String p2pPhase(WebDriver driver) {
        return (String) ((JavascriptExecutor) driver)
                .executeScript("return window.__silunetP2P?.state?.phase || null;");
    }

    private static long p2pRoundIndex(WebDriver driver) {
        Object value = ((JavascriptExecutor) driver)
                .executeScript("return window.__silunetP2P?.state?.currentRoundIndex ?? -1;");
        return ((Number) value).longValue();
    }

    private static long p2pTime(WebDriver driver) {
        Object value = ((JavascriptExecutor) driver)
                .executeScript("return window.__silunetP2P?.state?.round?.timeLeft ?? -1;");
        return ((Number) value).longValue();
    }

    private static long p2pSolverCount(WebDriver driver) {
        Object value = ((JavascriptExecutor) driver)
                .executeScript("return window.__silunetP2P?.state?.round?.solvers?.length || 0;");
        return ((Number) value).longValue();
    }

    private static int freePort() throws Exception {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    private static void waitForServer() throws Exception {
        HttpClient client = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .proxy(HttpClient.Builder.NO_PROXY)
                .connectTimeout(Duration.ofSeconds(2))
                .build();
        long deadline = System.currentTimeMillis() + 30_000;
        Exception last = null;
        while (System.currentTimeMillis() < deadline) {
            if (!server.isAlive()) {
                throw new IllegalStateException("El servidor P2P murió al arrancar: " + server.exitValue());
            }
            try {
                HttpRequest request = HttpRequest.newBuilder()
                        .uri(URI.create(baseUrl + "/api/info"))
                        .timeout(Duration.ofSeconds(2))
                        .GET()
                        .build();
                if (client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode() == 200) return;
            } catch (Exception error) {
                last = error;
            }
            Thread.sleep(250);
        }
        throw new IllegalStateException("Silunet no arrancó para la prueba P2P en " + baseUrl, last);
    }

    private static void deleteDatabase() throws Exception {
        if (database == null) return;
        Files.deleteIfExists(database);
        Files.deleteIfExists(Path.of(database + "-shm"));
        Files.deleteIfExists(Path.of(database + "-wal"));
    }
}
