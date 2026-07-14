function formatarDinheiro(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL"
  });
}

function converterValor(texto) {
  let valor = String(texto ?? "").trim().replace(/[R$\s]/gi, "");
  if (!valor) return NaN;
  if (valor.includes(",")) valor = valor.replace(/\./g, "").replace(",", ".");
  return Number(valor);
}

function paraCentavos(valor) {
  return Math.round(Number(valor) * 100);
}

function paraReais(centavos) {
  return Number(centavos || 0) / 100;
}

module.exports = { formatarDinheiro, converterValor, paraCentavos, paraReais };
