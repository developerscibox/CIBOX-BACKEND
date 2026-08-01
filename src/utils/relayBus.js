import { EventEmitter } from "node:events";

// Bus de eventos del relay de sala para empujar cambios en vivo por SSE
// (pantallas de retiro/turnos, cola de picking). Aditivo: si algo falla, nunca
// rompe la transacción que lo emite (try/catch).
export const relayBus = new EventEmitter();
relayBus.setMaxListeners(100);

export const emitRelayChange = (payload = {}) => {
  try {
    relayBus.emit("change", payload);
  } catch {
    /* el push en vivo nunca debe romper el flujo */
  }
};

export default { relayBus, emitRelayChange };
