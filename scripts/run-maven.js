#!/usr/bin/env node
/**
 * Lanza el Maven Wrapper del repo.
 *
 * Existe solo por portabilidad: en Windows hay que invocar `mvnw.cmd` y en
 * Linux (Jenkins) `./mvnw`. Sin esto, el mismo script de npm no puede correr
 * en las dos partes.
 *
 * Uso:  node scripts/run-maven.js test -Pselenium
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const esWindows = process.platform === 'win32';
const wrapper = path.join(RAIZ, esWindows ? 'mvnw.cmd' : 'mvnw');

// --batch-mode: sin colores ni barras de progreso, para que el log de
// Jenkins sea legible.
const hijo = spawn(wrapper, ['--batch-mode', ...process.argv.slice(2)], {
  cwd: RAIZ,
  stdio: 'inherit',
  shell: esWindows, // .cmd necesita el shell de Windows para ejecutarse
});

hijo.on('error', error => {
  console.error(`No se pudo ejecutar ${wrapper}: ${error.message}`);
  process.exit(1);
});
hijo.on('exit', codigo => process.exit(codigo ?? 1));
