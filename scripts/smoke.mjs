/**
 * Smoke de arranque SIN base de datos.
 *
 * Verifica lo que exige el checklist de cada fase: que no queden imports rotos
 * tras un borrado y que la app Express siga montando todas sus rutas. Importa
 * app.js (que arrastra routes → controllers → services → models), levanta el
 * servidor en un puerto efímero y pega a /health.
 *
 * Uso: node scripts/smoke.mjs   (desde backend/)
 */
process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.LOG_LEVEL = "error";

const { default: app } = await import("../src/app.js");

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});

const { port } = server.address();
const res = await fetch(`http://127.0.0.1:${port}/health`);
const body = await res.json();
server.close();

if (res.status !== 200 || body.status !== "ok") {
  console.error("❌ smoke: /health respondió", res.status, body);
  process.exit(1);
}

// El router de Express 5 expone las capas montadas; contarlas detecta que un
// borrado no se haya llevado por delante el montaje de rutas vivas.
const mounted = (app.router?.stack || []).filter((l) => l.name === "router").length;
console.log(`✅ smoke: app importada sin errores, /health ok, ${mounted} routers montados`);
