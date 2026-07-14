const Database = require("better-sqlite3");
const { gerarIdCurto, gerarCodigoHydra } = require("./utils/codes");
const { paraCentavos, paraReais } = require("./utils/money");

const db = new Database("hydra-wallet.db");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS wallets (
  user_id TEXT PRIMARY KEY,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  reserved_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  pix_key TEXT NOT NULL,
  recipient_name TEXT NOT NULL DEFAULT 'Destinatário',
  recipient_document TEXT,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  hydra_code TEXT,
  gateway_batch_id TEXT,
  gateway_status TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  gateway_id TEXT NOT NULL UNIQUE,
  gross_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  net_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  copy_paste TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  credited_at INTEGER
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  description TEXT NOT NULL,
  reference_id TEXT,
  created_at INTEGER NOT NULL
);
`);

function adicionarColunaSeFaltar(tabela, coluna, definicao) {
  const colunas = db.prepare(`PRAGMA table_info(${tabela})`).all().map(c => c.name);
  if (!colunas.includes(coluna)) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
}
adicionarColunaSeFaltar("payments", "recipient_document", "TEXT");
adicionarColunaSeFaltar("payments", "hydra_code", "TEXT");
adicionarColunaSeFaltar("payments", "gateway_batch_id", "TEXT");
adicionarColunaSeFaltar("payments", "gateway_status", "TEXT");
adicionarColunaSeFaltar("payments", "gateway_payout_id", "TEXT");
adicionarColunaSeFaltar("payments", "end_to_end_id", "TEXT");

function garantirCarteira(userId) {
  const agora = Date.now();
  db.prepare(`INSERT OR IGNORE INTO wallets(user_id,balance_cents,reserved_cents,created_at,updated_at) VALUES(?,0,0,?,?)`).run(userId, agora, agora);
}

function obterCarteira(userId) {
  garantirCarteira(userId);
  const w = db.prepare(`SELECT balance_cents,reserved_cents FROM wallets WHERE user_id=?`).get(userId);
  const extrato = db.prepare(`SELECT type AS tipo, amount_cents, description AS nome, reference_id AS id, created_at AS criadoEm FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 20`).all(userId);
  return { saldo: paraReais(w.balance_cents), reservado: paraReais(w.reserved_cents), extrato: extrato.map(x => ({...x, valor: paraReais(x.amount_cents)})) };
}

function adicionarSaldo(userId, valor, descricao="Crédito") {
  garantirCarteira(userId);
  const cents = paraCentavos(valor), agora = Date.now(), ref = gerarIdCurto();
  db.transaction(() => {
    db.prepare(`UPDATE wallets SET balance_cents=balance_cents+?,updated_at=? WHERE user_id=?`).run(cents, agora, userId);
    db.prepare(`INSERT INTO transactions(user_id,type,amount_cents,description,reference_id,created_at) VALUES(?,?,?,?,?,?)`).run(userId,"credito",cents,descricao,ref,agora);
  })();
  return obterCarteira(userId);
}

function criarPagamento({ usuarioId, chave, valor, nomeDestinatario="Destinatário", documentoDestinatario=null }) {
  garantirCarteira(usuarioId);
  const id = gerarIdCurto();
  db.prepare(`INSERT INTO payments(id,user_id,pix_key,recipient_name,recipient_document,amount_cents,status,hydra_code,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(id, usuarioId, chave, nomeDestinatario, documentoDestinatario, paraCentavos(valor), "aguardando_confirmacao", gerarCodigoHydra(), Date.now());
  return obterPagamento(id);
}

function obterPagamento(id) {
  const p = db.prepare(`SELECT * FROM payments WHERE id=?`).get(id);
  if (!p) return null;
  return { id:p.id, usuarioId:p.user_id, chave:p.pix_key, nomeDestinatario:p.recipient_name, documentoDestinatario:p.recipient_document, valor:paraReais(p.amount_cents), status:p.status, codigoHydra:p.hydra_code, batchId:p.gateway_batch_id, gatewayStatus:p.gateway_status, payoutId:p.gateway_payout_id, endToEndId:p.end_to_end_id, criadoEm:p.created_at, concluidoEm:p.completed_at };
}

function atualizarPagamento(id, campos={}) {
  const permitidos = { status:"status", batchId:"gateway_batch_id", gatewayStatus:"gateway_status", payoutId:"gateway_payout_id", endToEndId:"end_to_end_id", concluidoEm:"completed_at", nomeDestinatario:"recipient_name", documentoDestinatario:"recipient_document" };
  const sets=[], vals=[];
  for (const [k,v] of Object.entries(campos)) if (permitidos[k]) { sets.push(`${permitidos[k]}=?`); vals.push(v); }
  if (sets.length) db.prepare(`UPDATE payments SET ${sets.join(",")} WHERE id=?`).run(...vals,id);
  return obterPagamento(id);
}

function reservarSaldo(pagamento) {
  const cents=paraCentavos(pagamento.valor), agora=Date.now();
  db.transaction(() => {
    const w=db.prepare(`SELECT balance_cents FROM wallets WHERE user_id=?`).get(pagamento.usuarioId);
    if (!w || w.balance_cents<cents) throw new Error("SALDO_INSUFICIENTE");
    db.prepare(`UPDATE wallets SET balance_cents=balance_cents-?,reserved_cents=reserved_cents+?,updated_at=? WHERE user_id=?`).run(cents,cents,agora,pagamento.usuarioId);
    db.prepare(`UPDATE payments SET status='processando' WHERE id=?`).run(pagamento.id);
  })();
}

function concluirPagamento(pagamento, batchId, gatewayStatus="paid") {
  const cents = paraCentavos(pagamento.valor);
  const agora = Date.now();

  db.transaction(() => {
    const atual = db.prepare(`SELECT status FROM payments WHERE id=?`).get(pagamento.id);
    if (!atual || atual.status === "concluido") return;
    if (atual.status !== "processando") {
      throw new Error(`PAGAMENTO_NAO_PROCESSANDO:${atual.status}`);
    }

    db.prepare(`UPDATE wallets SET reserved_cents=MAX(0,reserved_cents-?),updated_at=? WHERE user_id=?`)
      .run(cents, agora, pagamento.usuarioId);
    db.prepare(`UPDATE payments SET status='concluido',gateway_batch_id=?,gateway_status=?,completed_at=? WHERE id=?`)
      .run(batchId, gatewayStatus, agora, pagamento.id);
    db.prepare(`INSERT INTO transactions(user_id,type,amount_cents,description,reference_id,created_at) VALUES(?,?,?,?,?,?)`)
      .run(pagamento.usuarioId, "pix_enviado", cents, pagamento.chave, pagamento.id, agora);
  })();

  return obterPagamento(pagamento.id);
}

function falharPagamento(pagamento, gatewayStatus="failed") {
  const cents = paraCentavos(pagamento.valor);
  const agora = Date.now();

  db.transaction(() => {
    const atual = db.prepare(`SELECT status FROM payments WHERE id=?`).get(pagamento.id);
    if (!atual || atual.status === "falhou") return;
    if (atual.status !== "processando") {
      throw new Error(`PAGAMENTO_NAO_PROCESSANDO:${atual.status}`);
    }

    db.prepare(`UPDATE wallets SET balance_cents=balance_cents+?,reserved_cents=MAX(0,reserved_cents-?),updated_at=? WHERE user_id=?`)
      .run(cents, cents, agora, pagamento.usuarioId);
    db.prepare(`UPDATE payments SET status='falhou',gateway_status=? WHERE id=?`)
      .run(gatewayStatus, pagamento.id);
  })();

  return obterPagamento(pagamento.id);
}



function corrigirPagamentoConcluidoAposEstorno(pagamento, batchId, gatewayStatus="paid") {
  const cents = paraCentavos(pagamento.valor);
  const agora = Date.now();

  db.transaction(() => {
    const atual = db.prepare(`SELECT status FROM payments WHERE id=?`).get(pagamento.id);
    if (!atual || atual.status === "concluido") return;
    if (atual.status !== "falhou") {
      throw new Error(`PAGAMENTO_NAO_ESTORNADO:${atual.status}`);
    }

    // A versão anterior devolvia o saldo antes da confirmação final da Turbofy.
    // Se a API confirmar que o Pix foi pago, removemos novamente o valor disponível.
    db.prepare(`UPDATE wallets SET balance_cents=balance_cents-?,updated_at=? WHERE user_id=?`)
      .run(cents, agora, pagamento.usuarioId);
    db.prepare(`UPDATE payments SET status='concluido',gateway_batch_id=?,gateway_status=?,completed_at=? WHERE id=?`)
      .run(batchId, gatewayStatus, agora, pagamento.id);
    db.prepare(`INSERT INTO transactions(user_id,type,amount_cents,description,reference_id,created_at) VALUES(?,?,?,?,?,?)`)
      .run(pagamento.usuarioId, "pix_enviado", cents, pagamento.chave, pagamento.id, agora);
  })();

  return obterPagamento(pagamento.id);
}

function listarPagamentosReconciliaveis() {
  return db.prepare(`
    SELECT id
    FROM payments
    WHERE status IN ('processando', 'falhou')
      AND gateway_batch_id IS NOT NULL
    ORDER BY created_at ASC
  `).all().map(({ id }) => obterPagamento(id));
}

function criarDeposito({ id, usuarioId, gatewayId, valorBruto, taxa, valorLiquido, copiaECola, expiraEm }) {
  garantirCarteira(usuarioId);
  db.prepare(`INSERT INTO deposits(id,user_id,gateway_id,gross_cents,fee_cents,net_cents,status,copy_paste,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(id, usuarioId, gatewayId, paraCentavos(valorBruto), paraCentavos(taxa), paraCentavos(valorLiquido), "pending", copiaECola || null, expiraEm || null, Date.now());
  return obterDeposito(id);
}

function obterDeposito(id) {
  const d = db.prepare(`SELECT * FROM deposits WHERE id=? OR gateway_id=?`).get(id, id);
  if (!d) return null;
  return {
    id: d.id, usuarioId: d.user_id, gatewayId: d.gateway_id,
    valorBruto: paraReais(d.gross_cents), taxa: paraReais(d.fee_cents), valorLiquido: paraReais(d.net_cents),
    status: d.status, copiaECola: d.copy_paste, expiraEm: d.expires_at, criadoEm: d.created_at,
    pagoEm: d.paid_at, creditadoEm: d.credited_at
  };
}

function marcarDepositoPago(id, status="paid") {
  const deposito = obterDeposito(id);
  if (!deposito) throw new Error("DEPOSITO_NAO_ENCONTRADO");
  if (deposito.creditadoEm) return deposito;
  const agora = Date.now();
  db.transaction(() => {
    db.prepare(`UPDATE wallets SET balance_cents=balance_cents+?,updated_at=? WHERE user_id=?`)
      .run(paraCentavos(deposito.valorLiquido), agora, deposito.usuarioId);
    db.prepare(`UPDATE deposits SET status=?,paid_at=?,credited_at=? WHERE id=?`)
      .run(status, agora, agora, deposito.id);
    db.prepare(`INSERT INTO transactions(user_id,type,amount_cents,description,reference_id,created_at) VALUES(?,?,?,?,?,?)`)
      .run(deposito.usuarioId, "deposito", paraCentavos(deposito.valorLiquido), "Depósito Pix", deposito.id, agora);
  })();
  return obterDeposito(deposito.id);
}

function atualizarStatusDeposito(id, status) {
  const deposito = obterDeposito(id);
  if (!deposito) return null;
  db.prepare(`UPDATE deposits SET status=? WHERE id=?`).run(status, deposito.id);
  return obterDeposito(deposito.id);
}

function definirSaldo(userId, valor=0) {
  garantirCarteira(userId);
  db.prepare(`UPDATE wallets SET balance_cents=?, reserved_cents=0, updated_at=? WHERE user_id=?`)
    .run(paraCentavos(valor), Date.now(), userId);
  return obterCarteira(userId);
}

module.exports = {
  obterCarteira,
  adicionarSaldo,
  definirSaldo,
  criarPagamento,
  obterPagamento,
  atualizarPagamento,
  reservarSaldo,
  concluirPagamento,
  falharPagamento,
  corrigirPagamentoConcluidoAposEstorno,
  listarPagamentosReconciliaveis,
  criarDeposito,
  obterDeposito,
  marcarDepositoPago,
  atualizarStatusDeposito
};
