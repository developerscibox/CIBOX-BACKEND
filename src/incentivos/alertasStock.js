// Alertas de stock (lógica pura): negativo, quiebre y crítico.
// Disponible real = stock - reserved - allocated (puede ser negativo = mal contado).
// El job/endpoint lee productos y dispara la notificación; el criterio vive acá.

function disponibleReal(p) {
  return (Number(p.stock) || 0) - (Number(p.reserved) || 0) - (Number(p.allocated) || 0);
}

/**
 * @param {Array<{name:string, stock:number, reserved?:number, allocated?:number}>} productos
 * @param {number} umbral  stock crítico (default 10)
 */
export function alertasStock(productos, umbral = 10) {
  const alertas = [];
  for (const p of productos) {
    const disp = disponibleReal(p);
    let nivel = null;
    if (disp < 0) nivel = "negativo";
    else if (disp === 0) nivel = "quiebre";
    else if (disp <= umbral) nivel = "critico";
    if (nivel) alertas.push({ name: p.name, disponible: disp, nivel });
  }
  const prio = { negativo: 0, quiebre: 1, critico: 2 };
  return alertas.sort((a, b) => prio[a.nivel] - prio[b.nivel] || a.disponible - b.disponible);
}
