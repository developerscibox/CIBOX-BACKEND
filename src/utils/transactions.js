import mongoose from "mongoose";

// Detecta el caso "Mongo standalone": las transacciones requieren replica set.
// En dev local (mongod standalone) no hay RS, por lo que se ejecuta el callback
// sin sesión/transacción. En producción (replica set / Atlas) se usa la
// transacción real sin cambios. Retrocompatible.
const isNoTransactionSupport = (err) => {
  const msg = String(err?.message || "");
  return (
    err?.code === 20 || // IllegalOperation
    err?.codeName === "IllegalOperation" ||
    /Transaction numbers are only allowed on a replica set member or mongos/i.test(
      msg,
    ) ||
    /Transactions are not supported/i.test(msg)
  );
};

export const withTransaction = async (fn) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } catch (err) {
    if (isNoTransactionSupport(err)) {
      // Fallback dev: ejecutar sin sesión. Pierde atomicidad multi-documento,
      // aceptable solo en standalone local; producción usa replica set.
      try {
        return await fn(null);
      } catch (fallbackErr) {
        // Sin replica set NO hay rollback: si el callback falla a mitad,
        // los cambios ya aplicados (p.ej. descuento de stock) NO se revierten.
        // No simulamos rollback; solo damos visibilidad y propagamos el error.
        console.warn(
          "[withTransaction] Fallback SIN transacción: el callback falló y NO hubo rollback atómico. Posible estado inconsistente (stock/carrito).",
          fallbackErr?.message || fallbackErr,
        );
        throw fallbackErr;
      }
    }
    throw err;
  } finally {
    await session.endSession();
  }
};
