# Pruebas unitarias, JUnit, Jenkins y SonarQube

## Qué se implementó

Silunet usa TypeScript, por lo que la cobertura real se genera con `c8` sobre tres unidades seleccionadas:

- `src/lamport.ts`: orden lógico de eventos distribuidos.
- `src/mutex.ts`: exclusión mutua y cola FIFO.
- `src/wordBank.ts`: dificultad, consistencia del banco y selección sin repeticiones.

`test/unit/SilunetTest.ts` contiene 11 pruebas unitarias. El umbral automático exige al menos 90 % en líneas, sentencias y funciones, y 85 % en ramas.

`test/junit/SilunetTest.java` usa JUnit 5 para comprobar el servidor Node real como caja negra. No se usa JaCoCo porque no puede medir código TypeScript.

`test/selenium/SilunetSeleniumTest.java` contiene 7 ejercicios funcionales con Selenium WebDriver. `test/selenium/P2PFireTest.java` añade la prueba de fuego con WebRTC y caída del único servidor. Ambas están marcadas con `@Tag("selenium")`; Surefire excluye esa etiqueta por defecto, así que `npm run test:junit` no abre navegadores y el perfil `-Pselenium` invierte el filtro.

## Resultados verificados

Última ejecución local:

- TypeScript: 11 pruebas aprobadas, 0 fallos.
- Cobertura: 98.77 % líneas, 98.77 % sentencias, 100 % funciones y 87 % ramas.
- JUnit: 9 pruebas aprobadas, 0 fallos y 0 errores.
- Selenium: 8 pruebas aprobadas, 0 fallos (7 funcionales + prueba P2P).

La cobertura corresponde únicamente a las tres unidades enumeradas. SonarQube analiza la calidad de todo `src/` y `public/`, pero el porcentaje de cobertura se limita explícitamente mediante `sonar.coverage.inclusions`.

## Comandos

Pruebas unitarias y cobertura:

```bash
npm ci
npm run test:unit
```

JUnit en Linux o en un agente Jenkins que tenga Node, Java 17+ y Maven:

```bash
npm run test:junit
```

Selenium:

```bash
npm run test:selenium

# Solo la prueba de fuego P2P
npm run test:p2p-fire
```

Resultados generados:

- `reports/unit/junit.xml`: ejecución de pruebas TypeScript.
- `coverage/index.html`: reporte visual de cobertura.
- `coverage/lcov.info`: cobertura importada por SonarQube.
- `target/surefire-reports/*.xml`: resultados JUnit/Maven.
- `reports/selenium/TEST-SilunetSeleniumTest.xml`: resultados Selenium.
- `reports/selenium/*.png`: capturas de evidencia.

## Configuración de Jenkins

El pipeline está en `test/jenkins/Jenkinsfile`. Configure ese valor en **Script Path** del trabajo Pipeline. El agente debe tener:

- Node.js y npm.
- Java 17 o posterior.
- Maven.
- Chrome/Chromium, o un Selenium Grid configurado mediante `SELENIUM_REMOTE_URL`.
- SonarScanner y el plugin SonarQube Scanner for Jenkins.

En **Administrar Jenkins > System > SonarQube servers**, registrar el servidor con el nombre exacto `SonarQube` y una credencial de token.

En SonarQube debe configurarse el webhook:

```text
http://jenkins:8080/sonarqube-webhook/
```

El webhook permite que `waitForQualityGate` reciba el resultado del Quality Gate.

## Servidor JUnit externo

Normalmente JUnit inicia automáticamente un nodo en un puerto libre. Si Silunet ya corre en otro contenedor:

```bash
SILUNET_BASE_URL=http://silunet:3001 \
SILUNET_EXPECTED_NODE_ID=node1 \
mvn --batch-mode test
```

En este modo JUnit no inicia ni detiene el servidor externo.
