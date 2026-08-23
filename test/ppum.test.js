import test from "node:test";
import assert from "node:assert/strict";

import {
  calcularPpum,
  formatearPpum,
  motivoExcepcion,
  normalizarCantidad,
  ppumDeProducto,
  resolverPreset,
} from "../src/catalogo/ppum.js";

// ── Normalización de unidades (art. 3° n°8) ──────────────────────────────────

test("normaliza masa a kilogramos", () => {
  assert.deepEqual(normalizarCantidad(900, "g"), { magnitud: "masa", cantidad: 0.9 });
  assert.deepEqual(normalizarCantidad(1, "kg"), { magnitud: "masa", cantidad: 1 });
  assert.deepEqual(normalizarCantidad(500, "GR"), { magnitud: "masa", cantidad: 0.5 });
});

test("normaliza volumen a litros, sin importar mayúsculas", () => {
  assert.deepEqual(normalizarCantidad(1.5, "L"), { magnitud: "volumen", cantidad: 1.5 });
  assert.deepEqual(normalizarCantidad(400, "ml"), { magnitud: "volumen", cantidad: 0.4 });
  assert.deepEqual(normalizarCantidad(750, "ML"), { magnitud: "volumen", cantidad: 0.75 });
});

test("descarta unidades desconocidas y cantidades no positivas", () => {
  assert.equal(normalizarCantidad(100, "puñados"), null);
  assert.equal(normalizarCantidad(0, "g"), null);
  assert.equal(normalizarCantidad(-5, "kg"), null);
  assert.equal(normalizarCantidad(100, ""), null);
});

// ── Gramos y kilos: misma unidad para el mismo tipo (art. 7°) ────────────────

test("gramos y kilos del mismo tipo de producto salen ambos en $/kg", () => {
  const arroz900 = calcularPpum({ precio: 1450, contenido: 900, unidad: "g" });
  const arroz1kg = calcularPpum({ precio: 1850, contenido: 1, unidad: "kg" });

  assert.equal(arroz900.etiqueta, "kg");
  assert.equal(arroz1kg.etiqueta, "kg");
  assert.equal(arroz900.valor, 1611);
  assert.equal(arroz1kg.valor, 1850);
});

test("mililitros y litros salen ambos en $/L", () => {
  const bebida = calcularPpum({ precio: 2290, contenido: 1.5, unidad: "L" });
  const aceite = calcularPpum({ precio: 2190, contenido: 900, unidad: "ml" });

  assert.equal(bebida.etiqueta, "L");
  assert.equal(aceite.etiqueta, "L");
  assert.equal(bebida.valor, 1527);
  assert.equal(aceite.valor, 2433);
});

// ── Packs de N unidades idénticas (art. 6°) ──────────────────────────────────

test("pack de unidades idénticas se informa por cada unidad", () => {
  const huevos = calcularPpum({ precio: 3490, contenido: 12, unidad: "un", preset: "huevos" });
  assert.equal(huevos.etiqueta, "unidad");
  assert.equal(huevos.valor, 291);
});

test("piezas sueltas del envase sirven cuando no hay contenido declarado", () => {
  const panales = calcularPpum({ precio: 12990, piezas: 40, preset: "higiene_pack" });
  assert.equal(panales.etiqueta, "unidad");
  assert.equal(panales.valor, 325);
});

test("art. 11 n°7: paquetes de 51 o más unidades van por cada 100 unidades", () => {
  const preset = resolverPreset({ nombre: "Fósforos surtidos", piezas: 60 });
  assert.equal(preset, "pack_51");

  const ppum = calcularPpum({ precio: 3000, contenido: 60, unidad: "un", preset });
  assert.equal(ppum.etiqueta, "100 unidades");
  assert.equal(ppum.valor, 5000);
});

// ── Granel (art. 5°) ─────────────────────────────────────────────────────────

test("a granel el precio de venta ES el precio por unidad de medida", () => {
  const ppum = calcularPpum({ precio: 1290, unidad: "kg", granel: true });
  assert.equal(ppum.valor, 1290);
  assert.equal(ppum.etiqueta, "kg");
  assert.equal(ppum.texto, "$1.290 por kg");
});

test("a granel sin unidad de venta no se publica nada", () => {
  assert.equal(calcularPpum({ precio: 1290, granel: true }), null);
});

// ── Datos faltantes: nunca un PPUM a medias ──────────────────────────────────

test("sin precio no hay PPUM", () => {
  assert.equal(calcularPpum({ precio: 0, contenido: 1, unidad: "kg" }), null);
  assert.equal(calcularPpum({ precio: -100, contenido: 1, unidad: "kg" }), null);
});

test("sin contenido ni piezas no hay PPUM", () => {
  assert.equal(calcularPpum({ precio: 1990 }), null);
  assert.equal(calcularPpum({ precio: 1990, contenido: 0, unidad: "g" }), null);
  assert.equal(calcularPpum({ precio: 1990, contenido: 500, unidad: "" }), null);
});

test("producto marcado como exceptuado no publica PPUM", () => {
  const producto = {
    price: 1990,
    unit_content: { value: 500, unit: "g" },
    ppum: { mode: "exempt", exempt_reason: "comida_preparada" },
  };
  assert.equal(ppumDeProducto(producto), null);
});

// ── Art. 11 n°5: productos en rollo ──────────────────────────────────────────

test("rollos con metraje conocido se informan por metro", () => {
  const ppum = calcularPpum({
    precio: 3290,
    contenido: 4,
    unidad: "rollos",
    piezas: 4,
    largoPorPieza: 25,
    preset: "rollo",
  });
  assert.equal(ppum.magnitud, "longitud");
  assert.equal(ppum.etiqueta, "m");
  assert.equal(ppum.valor, 33);
});

test("rollos sin metraje caen a por unidad en vez de quedar sin PPUM", () => {
  const ppum = calcularPpum({ precio: 3290, contenido: 4, unidad: "rollos", preset: "rollo" });
  assert.equal(ppum.magnitud, "conteo");
  assert.equal(ppum.etiqueta, "unidad");
  assert.equal(ppum.valor, 823);
});

// ── Art. 10: peso escurrido ──────────────────────────────────────────────────

test("cuando hay peso drenado, el PPUM se calcula sobre él", () => {
  const conDrenado = calcularPpum({ precio: 1590, contenido: 160, unidad: "g", contenidoDrenado: 100 });
  const sinDrenado = calcularPpum({ precio: 1590, contenido: 160, unidad: "g" });

  assert.equal(conDrenado.valor, 15900);
  assert.equal(sinDrenado.valor, 9938);
});

// ── Art. 11: unidades preestablecidas ────────────────────────────────────────

test("cosméticos van por 100 g o 100 ml", () => {
  const pasta = calcularPpum({ precio: 1790, contenido: 90, unidad: "g", preset: "cosmeticos" });
  const shampoo = calcularPpum({ precio: 4990, contenido: 400, unidad: "ml", preset: "cosmeticos" });

  assert.equal(pasta.etiqueta, "100 g");
  assert.equal(pasta.valor, 1989);
  assert.equal(shampoo.etiqueta, "100 ml");
  assert.equal(shampoo.valor, 1248);
});

test("hierbas y especias van por 10 g", () => {
  const ppum = calcularPpum({ precio: 890, contenido: 20, unidad: "g", preset: "especias" });
  assert.equal(ppum.etiqueta, "10 g");
  assert.equal(ppum.valor, 445);
});

test("esencias y colorantes van por 10 ml", () => {
  const ppum = calcularPpum({ precio: 1290, contenido: 30, unidad: "ml", preset: "esencias" });
  assert.equal(ppum.etiqueta, "10 ml");
  assert.equal(ppum.valor, 430);
});

// ── Resolución de preset por categoría (art. 7°) ─────────────────────────────

test("el preset se resuelve por categoría, no producto a producto", () => {
  assert.equal(resolverPreset({ nombre: "Shampoo anticaspa 400 ml", categoria: "Cuidado personal" }), "cosmeticos");
  assert.equal(resolverPreset({ nombre: "Pasta dental 90 g", categoria: "Cuidado personal" }), "cosmeticos");
});

test("las reglas por nombre del art. 11 ganan a la categoría", () => {
  assert.equal(
    resolverPreset({ nombre: "Papel Higiénico Black Triple Hoja Swan 4 rollos", categoria: "Cuidado personal" }),
    "rollo",
  );
  assert.equal(resolverPreset({ nombre: "Huevos color grandes", categoria: "Lácteos y huevos" }), "huevos");
  assert.equal(resolverPreset({ nombre: "Pañales Premium XG 40 un", categoria: "Cuidado personal" }), "higiene_pack");
});

test("un producto sin regla ni categoría especial no lleva preset", () => {
  assert.equal(resolverPreset({ nombre: "Arroz grado 1 · 1 kg", categoria: "Despensa" }), "");
});

// ── Art. 8° n°2: excepción bajo 50 g o ml ────────────────────────────────────

test("marca como exceptuados los productos bajo 50 g o ml", () => {
  assert.equal(motivoExcepcion({ contenido: 30, unidad: "g" }), "menor_a_50");
  assert.equal(motivoExcepcion({ contenido: 20, unidad: "ml" }), "menor_a_50");
  assert.equal(motivoExcepcion({ contenido: 90, unidad: "g" }), "");
});

test("los productos del art. 11 no pierden el PPUM por estar bajo 50 g", () => {
  assert.equal(motivoExcepcion({ contenido: 10, unidad: "g", preset: "especias" }), "");
});

// ── Formato del art. 9° ──────────────────────────────────────────────────────

test("el texto usa el formato $[precio] por [unidad de medida]", () => {
  assert.equal(formatearPpum(1611, "kg"), "$1.611 por kg");
  assert.equal(formatearPpum(291, "unidad"), "$291 por unidad");
  assert.equal(formatearPpum(5000, "100 unidades"), "$5.000 por 100 unidades");
});

test("los PPUM bajo $10 conservan un decimal", () => {
  const ppum = calcularPpum({ precio: 400, contenido: 1, unidad: "kg", preset: "especias" });
  assert.equal(ppum.valor, 4);
  assert.equal(ppum.etiqueta, "10 g");
});

// ── Integración sobre el documento de producto ───────────────────────────────

test("resuelve el PPUM de un producto tal como vive en Mongo", () => {
  const ppum = ppumDeProducto({
    name: "Bebida cola 1,5 L",
    price: 2290,
    category: { name: "Bebidas y jugos" },
    unit_content: { value: 1.5, unit: "L" },
  });
  assert.equal(ppum.texto, "$1.527 por L");
});

test("un producto de cuidado personal hereda el preset de su categoría", () => {
  const ppum = ppumDeProducto({
    name: "Shampoo anticaspa 400 ml",
    price: 4990,
    category: { name: "Cuidado personal" },
    unit_content: { value: 400, unit: "ml" },
  });
  assert.equal(ppum.texto, "$1.248 por 100 ml");
});

test("los campos de ppum del producto pisan al contenido declarado", () => {
  const ppum = ppumDeProducto({
    name: "Papel Higiénico Swan 4 rollos",
    price: 3290,
    category: { name: "Cuidado personal" },
    unit_content: { value: 4, unit: "rollos" },
    ppum: { pieces_per_pack: 4, length_per_piece_m: 25 },
  });
  assert.equal(ppum.texto, "$33 por m");
});

test("un producto con el subdocumento ppum ya guardado en 0 conserva su PPUM", () => {
  // Regresión: el esquema defaultea net_value/pieces a 0, no a undefined. Con
  // `??` el override ganaba siempre y el producto quedaba sin precio unitario.
  const ppum = ppumDeProducto({
    name: "Lavalozas Concentrado 700 ml",
    price: 1090,
    category: { name: "Limpieza" },
    unit_content: { value: 700, unit: "ml" },
    ppum: {
      mode: "auto",
      net_value: 0,
      net_unit: "",
      drained_value: 0,
      pieces_per_pack: 0,
      length_per_piece_m: 0,
      bulk: false,
      preset: "",
    },
  });
  assert.equal(ppum?.texto, "$1.557 por L");
});

test("el PPUM se recalcula sobre el precio realmente cobrado", () => {
  const producto = {
    name: "Galletas de vainilla 140 g",
    price: 890,
    category: { name: "Snacks" },
    unit_content: { value: 140, unit: "g" },
  };
  assert.equal(ppumDeProducto(producto)?.texto, "$6.357 por kg");
  assert.equal(ppumDeProducto(producto, 782)?.texto, "$5.586 por kg");
});

test("una hierba en el nombre no convierte al producto en especia", () => {
  // El orégano del queso es un sabor, no el producto. Si se tratara como
  // especia, el queso saldría por 10 g y el resto de los quesos por kilo.
  assert.equal(resolverPreset({ nombre: "QUESO EDAM OREGANO QUILLAYES 325G", categoria: "Lácteos, Huevos" }), "");
  assert.equal(resolverPreset({ nombre: "SALSA UNTAR AJO OREGANO GOURMET 200G", categoria: "Salsas" }), "");
  assert.equal(resolverPreset({ nombre: "OREGANO MOLIDO K", categoria: "Condimentos y especias" }), "especias");
});

test("la categoría de condimentos deja a todos sus productos en la misma unidad", () => {
  assert.equal(resolverPreset({ nombre: "ALIÑO COMPLETO K", categoria: "Condimentos y especias" }), "especias");
  assert.equal(resolverPreset({ nombre: "MERKEN AHUMADO 80G", categoria: "Condimentos y especias" }), "especias");
});
