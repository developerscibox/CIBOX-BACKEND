import test from "node:test";
import assert from "node:assert/strict";
import { agruparPorSector } from "../src/wms/sectores.js";
import { canRoleTransition, ROLES } from "../src/utils/constants.js";

test("agruparPorSector: agrupa por sector y ordena por recorrido", () => {
  const items = [
    { nombre: "Leche", cantidad: 2, precioUnit: 1000, sector: "Lácteos" },
    { nombre: "Arroz", cantidad: 3, precioUnit: 1200, sector: "Abarrotes" },
    { nombre: "Yogurt", cantidad: 1, precioUnit: 800, sector: "Lácteos" },
  ];
  const orden = { Abarrotes: 1, Lácteos: 2 };
  const grupos = agruparPorSector(items, orden);
  assert.equal(grupos.length, 2);
  assert.equal(grupos[0].sector, "Abarrotes"); // recorrido orden 1 primero
  assert.equal(grupos[1].sector, "Lácteos");
  assert.equal(grupos[1].items.length, 2);
  assert.equal(grupos[1].subtotal, 2 * 1000 + 1 * 800);
});

test("agruparPorSector: 'Sin sector' va al final", () => {
  const items = [
    { nombre: "X", cantidad: 1, precioUnit: 100, sector: "Abarrotes" },
    { nombre: "Y", cantidad: 1, precioUnit: 100 },
  ];
  const grupos = agruparPorSector(items, { Abarrotes: 5 });
  assert.equal(grupos[grupos.length - 1].sector, "Sin sector");
});

test("canRoleTransition: relay estricto por rol", () => {
  // cajera cobra (→paid) pero NO prepara
  assert.equal(canRoleTransition(ROLES.CASHIER, "paid"), true);
  assert.equal(canRoleTransition(ROLES.CASHIER, "ready"), false);
  // bodeguero prepara/listo pero NO cobra
  assert.equal(canRoleTransition(ROLES.OPERATOR, "preparing"), true);
  assert.equal(canRoleTransition(ROLES.OPERATOR, "ready"), true);
  assert.equal(canRoleTransition(ROLES.OPERATOR, "paid"), false);
  // vendedor de sala no transiciona status (solo crea el pedido)
  assert.equal(canRoleTransition(ROLES.VENDEDOR, "paid"), false);
  // gerente y admin pueden cualquier transición del relay
  assert.equal(canRoleTransition(ROLES.MANAGER, "paid"), true);
  assert.equal(canRoleTransition(ROLES.MANAGER, "ready"), true);
  assert.equal(canRoleTransition(ROLES.ADMIN, "delivered"), true);
});
