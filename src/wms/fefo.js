// FEFO (First-Expired-First-Out): orden de picking por vencimiento más próximo.
// Lógica pura testeable. Los lotes sin vencimiento van al final.

/**
 * @param {Array<{producto?:string, cantidad?:number, expiry_date?:string|null}>} lotes
 */
export function ordenarFEFO(lotes) {
  return [...lotes].sort((a, b) => {
    const ea = a.expiry_date ? new Date(a.expiry_date).getTime() : Infinity;
    const eb = b.expiry_date ? new Date(b.expiry_date).getTime() : Infinity;
    return ea - eb;
  });
}
