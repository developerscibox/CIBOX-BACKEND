// =============================================================================
// Puerto de emisión de DTE (Documento Tributario Electrónico).
//
// ⚠️ REGLA INVIOLABLE 5: NO se construye emisión real (certificado digital, folios
// CAF, firma de XML) de cero. La emisión real se delega a un PROVEEDOR AUTORIZADO
// (OpenFactura / Lioren / LibreDTE) — NEEDS-INPUT B7 (proveedor + credenciales).
//
// Acá solo definimos el BORDE: una interfaz `DteEmitter.emitir(dte)` y un adapter
// sandbox para tests, de modo que el adapter del proveedor enchufe limpio después
// y reemplace el `siiService` stub sin tocar el resto del flujo.
// =============================================================================

/**
 * Interfaz (contrato): todo emisor implementa `emitir(dte) -> Promise<resultado>`.
 * dte: { tipo, receptor, items, neto, iva, total }
 */

export class SandboxDteEmitter {
  async emitir(dte) {
    return {
      ok: true,
      entorno: "sandbox",
      tipo: dte?.tipo ?? "boleta",
      folio: `SANDBOX-${dte?.total ?? 0}`,
      estado: "no-valido-ante-sii", // jamás se confunde con un DTE real
      total: dte?.total ?? 0,
    };
  }
}

/**
 * Fábrica del emisor. Sin proveedor configurado → sandbox. Con un proveedor real
 * pero sin adapter implementado → error explícito (NEEDS-INPUT B7), nunca emite
 * algo inválido en silencio.
 */
export function getDteEmitter(config = {}) {
  const provider = config.provider || "sandbox";
  if (provider === "sandbox") return new SandboxDteEmitter();
  throw new Error(
    `Proveedor DTE '${provider}' no implementado: requiere credenciales + certificado (B7). ` +
      "Implementar un adapter que cumpla DteEmitter.emitir() contra su API.",
  );
}
