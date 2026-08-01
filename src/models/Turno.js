import mongoose from "mongoose";

/**
 * Turno de ATENCIÓN presencial (fila para ser atendido en el mostrador).
 * El cliente escanea el QR de la entrada, escribe su nombre y recibe un número
 * correlativo del día. Distinto del PEDIDO (que se sigue en /orders/board):
 * el turno es la espera para comprar/ser atendido; al atenderlo nace el pedido.
 *
 * Estados:
 *   waiting    → en la fila, esperando ser llamado
 *   calling    → el vendedor lo llamó (¡pasa al mostrador!)
 *   attending  → siendo atendido
 *   done       → atención finalizada (opcional order_id si derivó en pedido)
 *   cancelled  → no se presentó / anulado
 */
const TURNO_STATUSES = ["waiting", "calling", "attending", "done", "cancelled"];

const turnoSchema = new mongoose.Schema(
  {
    day_key: { type: String, required: true, index: true }, // "YYYY-MM-DD" America/Santiago
    number: { type: Number, required: true }, // correlativo del día
    code: { type: String, required: true }, // "T-042" (para mostrar)
    name: { type: String, required: true, trim: true, maxlength: 80 },

    // Kiosko de autoatención: motivo del turno y RUT opcional del cliente.
    // rut se guarda normalizado (sin puntos, con guión, ej. "12345678-9") y es
    // dato de uso INTERNO: los endpoints públicos jamás lo exponen.
    tipo: { type: String, enum: ["compra", "retiro"], default: "compra" },
    rut: { type: String, default: null },

    status: { type: String, enum: TURNO_STATUSES, default: "waiting", index: true },

    called_at: { type: Date, default: null },
    called_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    module: { type: String, default: null }, // nombre del módulo de atención asignado al llamar
    attended_at: { type: Date, default: null },
    done_at: { type: Date, default: null },

    // Si la atención derivó en una venta/pedido, se enlaza aquí.
    order_id: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

// DOS FILAS con numeración propia (T-001… tienda / P-001… pedidos internet): el
// correlativo es por día Y POR TIPO. (El índice legado {day_key,number} único se
// elimina en turnoService.ensureTurnoIndexes, o chocarían T-005 y P-005.)
turnoSchema.index({ day_key: 1, tipo: 1, number: 1 }, { unique: true });
turnoSchema.index({ day_key: 1, status: 1, number: 1 });

export const TURNO_STATUSES_LIST = TURNO_STATUSES;
export const Turno = mongoose.models.Turno || mongoose.model("Turno", turnoSchema);
export default Turno;
