/**
 * Validador oficial de RUT chileno (módulo 11).
 * Acepta formatos con/sin puntos y guion. Devuelve true si el dígito verificador es correcto.
 */

const cleanRut = (rut) =>
  String(rut || "")
    .replace(/\./g, "")
    .replace(/-/g, "")
    .trim()
    .toUpperCase();

export const isValidRut = (rut) => {
  const clean = cleanRut(rut);
  if (clean.length < 2) return false;
  if (!/^[0-9]+[0-9K]$/.test(clean)) return false;

  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);

  if (body.length < 1 || body.length > 8) return false;

  let sum = 0;
  let multiplier = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }

  const remainder = 11 - (sum % 11);
  let expectedDv;
  if (remainder === 11) expectedDv = "0";
  else if (remainder === 10) expectedDv = "K";
  else expectedDv = String(remainder);

  return expectedDv === dv;
};

export const formatRut = (rut) => {
  const clean = cleanRut(rut);
  if (clean.length < 2) return clean;
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  const formattedBody = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${formattedBody}-${dv}`;
};
