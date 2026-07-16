const crypto = require("crypto");

const esperar = ms => new Promise(resolve => setTimeout(resolve, ms));
const ESPERA_RETRY_MS = Math.max(60000, Number(process.env.PIX_RETRY_DELAY_MS || 60000));
const INTERVALO_API_MS = Math.max(500, Number(process.env.TURBOFY_QUEUE_INTERVAL_MS || 1200));

let caudaFila = Promise.resolve();
let ultimaChamadaEm = 0;
const operacoesAtivas = new Map();

function enfileirar(funcao) {
  const executar = async () => {
    const espera = Math.max(0, INTERVALO_API_MS - (Date.now() - ultimaChamadaEm));
    if (espera) await esperar(espera);
    try {
      return await funcao();
    } finally {
      ultimaChamadaEm = Date.now();
    }
  };
  const promessa = caudaFila.then(executar, executar);
  caudaFila = promessa.catch(() => {});
  return promessa;
}

function erroPermiteRetry(erro) {
  const status = Number(erro?.status || 0);
  const code = String(erro?.code || "").toUpperCase();
  const msg = String(erro?.message || "").toUpperCase();

  if ([401, 403].includes(status)) return false;
  if (["INVALID_CREDENTIALS", "INVALID_SIGNATURE", "INSUFFICIENT_AVAILABLE_BALANCE", "INVALID_AMOUNT"].includes(code)) return false;
  if (status === 429 || status === 408 || status >= 500 || status === 0) return true;
  if (/PIX.*(INVALID|KEY)|INVALID.*PIX|CHAVE.*INVALID|RATE.?LIMIT|TIMEOUT|TEMPOR|UNAVAILABLE|INSTABIL/.test(`${code} ${msg}`)) return true;
  return false;
}

async function executarPayoutSeguro({ paymentId, executar, onRetryAgendado }) {
  if (operacoesAtivas.has(paymentId)) return operacoesAtivas.get(paymentId);

  const promessa = (async () => {
    const idempotencyKey = `hydra-${paymentId}`;
    let ultimoErro;

    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      try {
        console.log(`[SEGURANCA PIX] ${paymentId} - tentativa ${tentativa}/2 iniciada.`);
        const resultado = await enfileirar(() => executar({ tentativa, idempotencyKey }));
        console.log(`[SEGURANCA PIX] ${paymentId} - solicitação aceita pela Turbofy.`);
        return { ...resultado, tentativa, idempotencyKey };
      } catch (erro) {
        ultimoErro = erro;
        console.error(`[SEGURANCA PIX] ${paymentId} - tentativa ${tentativa}/2 falhou:`, erro.code || erro.message);
        if (tentativa >= 2 || !erroPermiteRetry(erro)) throw erro;

        const espera = Math.max(ESPERA_RETRY_MS, Number(erro.retryAfterMs || 0));
        console.warn(`[SEGURANCA PIX] ${paymentId} - nova tentativa em ${Math.ceil(espera / 1000)} segundos.`);
        if (onRetryAgendado) await Promise.resolve(onRetryAgendado({ esperaMs: espera, erro })).catch(() => {});
        await esperar(espera);
      }
    }
    throw ultimoErro;
  })().finally(() => operacoesAtivas.delete(paymentId));

  operacoesAtivas.set(paymentId, promessa);
  return promessa;
}

module.exports = { executarPayoutSeguro, erroPermiteRetry, enfileirar };
