// MTA Nation POS — API (Cloudflare Pages Functions + D1, binding "DB")
// Rotas em /api/*. Ver docs/POS.md.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, pin_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'seller', commission REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created TEXT)`,
  `CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS login_fail(ip TEXT, ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS stock(product_id TEXT NOT NULL, cor TEXT NOT NULL, size TEXT NOT NULL, qty INTEGER, PRIMARY KEY(product_id,cor,size))`,
  `CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, ts INTEGER NOT NULL, user_id INTEGER NOT NULL, channel TEXT, payment TEXT, delivery INTEGER NOT NULL DEFAULT 0, subtotal INTEGER NOT NULL DEFAULT 0, customer TEXT, phone TEXT, notes TEXT, void INTEGER NOT NULL DEFAULT 0, void_by INTEGER, void_reason TEXT)`,
  `CREATE INDEX IF NOT EXISTS sales_day ON sales(day)`,
  `CREATE TABLE IF NOT EXISTS sale_items(id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL, product_id TEXT NOT NULL, name TEXT, cor TEXT, size TEXT, qty INTEGER NOT NULL, unit_price INTEGER NOT NULL, list_price INTEGER)`,
  `CREATE INDEX IF NOT EXISTS items_sale ON sale_items(sale_id)`,
  `CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, type TEXT, amount INTEGER NOT NULL, notes TEXT, user_id INTEGER, ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS stock_log(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, user_id INTEGER, product_id TEXT, cor TEXT, size TEXT, before INTEGER, after INTEGER, reason TEXT)`,
  `CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS cash_moves(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT, type TEXT NOT NULL, amount INTEGER NOT NULL, counted INTEGER, expected INTEGER, user_id INTEGER, notes TEXT)`,
];
let ready = false;
async function init(db) {
  if (ready) return;
  await db.batch(SCHEMA.map(s => db.prepare(s)));
  try { await db.prepare(`ALTER TABLE expenses ADD COLUMN paid_cash INTEGER NOT NULL DEFAULT 1`).run(); } catch (e) { /* já existe */ }
  ready = true;
}

const SALT = "mta-pos-v1";
async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SALT + s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
const json = (d, status = 200, h = {}) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...h } });
const err = (msg, status = 400) => json({ error: msg }, status);
// Data de Maputo (UTC+2)
const today = () => new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);
const COR_LABEL = { ouro: "Dourado", prata: "Prateado", "-": "—" };

async function auth(req, db) {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!t) return null;
  const u = await db.prepare(`SELECT u.id,u.name,u.role,u.commission FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1`).bind(t, Date.now()).first();
  return u || null;
}

async function saleDetail(db, where, binds) {
  const sales = (await db.prepare(`SELECT s.*, u.name AS seller FROM sales s JOIN users u ON u.id=s.user_id WHERE ${where} ORDER BY s.id`).bind(...binds).all()).results;
  if (!sales.length) return [];
  const ids = sales.map(s => s.id);
  const items = (await db.prepare(`SELECT * FROM sale_items WHERE sale_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`).bind(...ids).all()).results;
  sales.forEach(s => s.items = items.filter(i => i.sale_id === s.id));
  return sales;
}

async function adjustStock(db, user, rows, reason) {
  // rows: [{product_id,cor,size,delta}] — só mexe em linhas que existem e têm número
  const out = [];
  for (const r of rows) {
    const cur = await db.prepare(`SELECT qty FROM stock WHERE product_id=? AND cor=? AND size=?`).bind(r.product_id, r.cor, r.size).first();
    if (!cur || cur.qty == null) continue;
    const after = Math.max(0, cur.qty + r.delta);
    out.push(db.prepare(`UPDATE stock SET qty=? WHERE product_id=? AND cor=? AND size=?`).bind(after, r.product_id, r.cor, r.size));
    out.push(db.prepare(`INSERT INTO stock_log(ts,user_id,product_id,cor,size,before,after,reason) VALUES(?,?,?,?,?,?,?,?)`).bind(Date.now(), user.id, r.product_id, r.cor, r.size, cur.qty, after, reason));
  }
  if (out.length) await db.batch(out);
}

function parseCSV(t) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; } else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; } else if (c !== "\r") f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const csvCell = v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

export async function onRequest(ctx) {
  const { request: req, env, params } = ctx;
  const db = env.DB;
  if (!db) return err("Base de dados não ligada (binding DB em falta)", 500);
  await init(db);
  const path = "/" + (params.path || []).join("/");
  const m = req.method;
  const url = new URL(req.url);
  let body = {};
  if (m !== "GET" && m !== "HEAD") { try { body = await req.json(); } catch (e) { body = {}; } }

  // ---------- Público ----------
  if (path === "/stock" && m === "GET") {
    // Mesmo formato da Google Sheet: Categoria,Produto,Cor,Tamanho,Stock,ID
    const rows = (await db.prepare(`SELECT * FROM stock ORDER BY product_id,cor,size`).all()).results;
    const csv = ["Categoria,Produto,Cor,Tamanho,Stock,ID"].concat(rows.map(r => ["", "", COR_LABEL[r.cor] || r.cor, r.size === "-" ? "—" : r.size, r.qty == null ? "" : r.qty, r.product_id].map(csvCell).join(","))).join("\n");
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "public, max-age=30" } });
  }
  if (path === "/status" && m === "GET") {
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM users`).first();
    return json({ ok: true, setup: n.n === 0 });
  }
  if (path === "/setup" && m === "POST") {
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM users`).first();
    if (n.n > 0) return err("Já configurado", 403);
    const name = String(body.name || "").trim(), pin = String(body.pin || "");
    if (!name || !/^\d{4,8}$/.test(pin)) return err("Nome e PIN (4–8 dígitos) obrigatórios");
    await db.prepare(`INSERT INTO users(name,pin_hash,role,commission,created) VALUES(?,?, 'admin', 0, ?)`).bind(name, await sha(pin), today()).run();
    return json({ ok: true });
  }
  if (path === "/login" && m === "POST") {
    const ip = req.headers.get("cf-connecting-ip") || "x";
    const since = Date.now() - 15 * 60e3;
    const fails = await db.prepare(`SELECT COUNT(*) AS n FROM login_fail WHERE ip=? AND ts>?`).bind(ip, since).first();
    if (fails.n >= 10) return err("Demasiadas tentativas. Espera 15 minutos.", 429);
    const pin = String(body.pin || "");
    const u = await db.prepare(`SELECT id,name,role,commission FROM users WHERE pin_hash=? AND active=1`).bind(await sha(pin)).first();
    if (!u) { await db.prepare(`INSERT INTO login_fail(ip,ts) VALUES(?,?)`).bind(ip, Date.now()).run(); return err("PIN incorreto", 401); }
    const token = [...crypto.getRandomValues(new Uint8Array(24))].map(x => x.toString(16).padStart(2, "0")).join("");
    await db.batch([
      db.prepare(`INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)`).bind(token, u.id, Date.now() + 14 * 3600e3),
      db.prepare(`DELETE FROM sessions WHERE expires<?`).bind(Date.now()),
      db.prepare(`DELETE FROM login_fail WHERE ts<?`).bind(since),
    ]);
    return json({ token, user: u });
  }

  // ---------- Autenticado ----------
  const user = await auth(req, db);
  if (!user) return err("Sessão expirada", 401);
  const admin = user.role === "admin";
  const mgr = admin || user.role === "manager";

  if (path === "/logout" && m === "POST") {
    const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    await db.prepare(`DELETE FROM sessions WHERE token=?`).bind(t).run();
    return json({ ok: true });
  }
  if (path === "/boot" && m === "GET") {
    const stock = (await db.prepare(`SELECT product_id,cor,size,qty FROM stock`).all()).results;
    const users = (await db.prepare(`SELECT id,name,role,commission,active FROM users ORDER BY id`).all()).results;
    const settings = Object.fromEntries((await db.prepare(`SELECT k,v FROM settings`).all()).results.map(r => [r.k, r.v]));
    return json({ user, stock, users, settings, today: today() });
  }

  // Vendas
  if (path === "/sales" && m === "POST") {
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return err("Carrinho vazio");
    for (const i of items) { if (!i.product_id || !(i.qty > 0) || !(i.unit_price >= 0)) return err("Artigo inválido"); }
    let sellerId = user.id;
    if (body.user_id && body.user_id !== user.id) {
      if (!mgr) return err("Só a gerência pode registar em nome de outro vendedor", 403);
      sellerId = +body.user_id;
    }
    const subtotal = items.reduce((a, i) => a + Math.round(i.unit_price) * Math.round(i.qty), 0);
    const day = mgr && /^\d{4}-\d{2}-\d{2}$/.test(body.day || "") ? body.day : today();
    const r = await db.prepare(`INSERT INTO sales(day,ts,user_id,channel,payment,delivery,subtotal,customer,phone,notes) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .bind(day, Date.now(), sellerId, body.channel || "Loja", body.payment || "", Math.round(+body.delivery || 0), subtotal, (body.customer || "").slice(0, 80), (body.phone || "").slice(0, 30), (body.notes || "").slice(0, 300)).run();
    const saleId = r.meta.last_row_id;
    await db.batch(items.map(i => db.prepare(`INSERT INTO sale_items(sale_id,product_id,name,cor,size,qty,unit_price,list_price) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(saleId, i.product_id, (i.name || "").slice(0, 120), i.cor || "-", i.size || "-", Math.round(i.qty), Math.round(i.unit_price), i.list_price == null ? null : Math.round(i.list_price))));
    await adjustStock(db, user, items.map(i => ({ product_id: i.product_id, cor: i.cor || "-", size: i.size || "-", delta: -Math.round(i.qty) })), `venda #${saleId}`);
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM sales WHERE day=? AND id<=?`).bind(day, saleId).first();
    return json({ ok: true, id: saleId, number: n.n });
  }
  if (path === "/sales" && m === "GET") {
    const day = url.searchParams.get("day") || today();
    const sales = await saleDetail(db, "s.day=?", [day]);
    const expenses = (await db.prepare(`SELECT e.*, u.name AS by_name FROM expenses e LEFT JOIN users u ON u.id=e.user_id WHERE e.day=? ORDER BY e.id`).bind(day).all()).results;
    return json({ day, sales, expenses });
  }
  const voidM = path.match(/^\/sales\/(\d+)\/void$/);
  if (voidM && m === "POST") {
    if (!mgr) return err("Só a gerência pode anular vendas", 403);
    const s = (await saleDetail(db, "s.id=?", [+voidM[1]]))[0];
    if (!s) return err("Venda não encontrada", 404);
    if (s.void) return err("Já anulada");
    await db.prepare(`UPDATE sales SET void=1, void_by=?, void_reason=? WHERE id=?`).bind(user.id, (body.reason || "").slice(0, 200), s.id).run();
    await adjustStock(db, user, s.items.map(i => ({ product_id: i.product_id, cor: i.cor, size: i.size, delta: i.qty })), `anulação #${s.id}`);
    return json({ ok: true });
  }

  // Despesas
  if (path === "/expenses" && m === "POST") {
    const amount = Math.round(+body.amount || 0);
    if (!(amount > 0)) return err("Valor inválido");
    const day = mgr && /^\d{4}-\d{2}-\d{2}$/.test(body.day || "") ? body.day : today();
    await db.prepare(`INSERT INTO expenses(day,type,amount,notes,user_id,ts,paid_cash) VALUES(?,?,?,?,?,?,?)`).bind(day, (body.type || "Outros").slice(0, 60), amount, (body.notes || "").slice(0, 200), user.id, Date.now(), body.paid_cash === 0 ? 0 : 1).run();
    return json({ ok: true });
  }
  const expDel = path.match(/^\/expenses\/(\d+)$/);
  if (expDel && m === "DELETE") {
    if (!mgr) return err("Só a gerência pode apagar despesas", 403);
    await db.prepare(`DELETE FROM expenses WHERE id=?`).bind(+expDel[1]).run();
    return json({ ok: true });
  }

  // Stock (admin)
  if (path === "/stock" && m === "PUT") {
    if (!admin) return err("Só o admin pode alterar stock", 403);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const stmts = [];
    for (const r of rows) {
      if (!r.product_id) continue;
      const cor = r.cor || "-", size = String(r.size || "-");
      const qty = r.qty === "" || r.qty == null ? null : Math.max(0, Math.round(+r.qty));
      const cur = await db.prepare(`SELECT qty FROM stock WHERE product_id=? AND cor=? AND size=?`).bind(r.product_id, cor, size).first();
      stmts.push(db.prepare(`INSERT INTO stock(product_id,cor,size,qty) VALUES(?,?,?,?) ON CONFLICT(product_id,cor,size) DO UPDATE SET qty=excluded.qty`).bind(r.product_id, cor, size, qty));
      if (!cur || cur.qty !== qty) stmts.push(db.prepare(`INSERT INTO stock_log(ts,user_id,product_id,cor,size,before,after,reason) VALUES(?,?,?,?,?,?,?,?)`).bind(Date.now(), user.id, r.product_id, cor, size, cur ? cur.qty : null, qty, body.reason || "ajuste manual"));
    }
    for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
    return json({ ok: true, n: rows.length });
  }
  if (path === "/stock/import" && m === "POST") {
    if (!admin) return err("Só o admin", 403);
    const src = String(body.url || "");
    if (!/^https:\/\/docs\.google\.com\/spreadsheets\//.test(src)) return err("Link inválido");
    const t = await (await fetch(src)).text();
    const MK = { dourado: "ouro", prateado: "prata" };
    const rows = parseCSV(t).slice(1).map(r => ({ product_id: (r[5] || "").trim(), cor: MK[(r[2] || "").trim().toLowerCase()] || "-", size: ((r[3] || "").trim().replace(/^—$/, "-")) || "-", qty: (r[4] || "").trim() })).filter(r => r.product_id);
    const stmts = rows.map(r => db.prepare(`INSERT INTO stock(product_id,cor,size,qty) VALUES(?,?,?,?) ON CONFLICT(product_id,cor,size) DO UPDATE SET qty=excluded.qty`).bind(r.product_id, r.cor, r.size, r.qty === "" || isNaN(+r.qty) ? null : Math.max(0, Math.round(+r.qty))));
    for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
    await db.prepare(`INSERT INTO stock_log(ts,user_id,product_id,cor,size,before,after,reason) VALUES(?,?,?,?,?,?,?,?)`).bind(Date.now(), user.id, "*", "", "", null, rows.length, "importação Google Sheet").run();
    return json({ ok: true, n: rows.length, withQty: rows.filter(r => r.qty !== "").length });
  }
  if (path === "/stock/log" && m === "GET") {
    const pid = url.searchParams.get("product");
    const rows = (await db.prepare(`SELECT l.*, u.name AS by_name FROM stock_log l LEFT JOIN users u ON u.id=l.user_id ${pid ? "WHERE l.product_id=?" : ""} ORDER BY l.id DESC LIMIT 200`).bind(...(pid ? [pid] : [])).all()).results;
    return json({ rows });
  }

  // Equipa (admin)
  if (path === "/users" && m === "POST") {
    if (!admin) return err("Só o admin", 403);
    const name = String(body.name || "").trim(), pin = String(body.pin || "");
    if (!name || !/^\d{4,8}$/.test(pin)) return err("Nome e PIN (4–8 dígitos) obrigatórios");
    try {
      await db.prepare(`INSERT INTO users(name,pin_hash,role,commission,created) VALUES(?,?,?,?,?)`).bind(name, await sha(pin), (["admin","manager"].includes(body.role) ? body.role : "seller"), Math.max(0, +body.commission || 0), today()).run();
    } catch (e) { return err("Esse PIN já está a ser usado. Escolhe outro."); }
    return json({ ok: true });
  }
  const uM = path.match(/^\/users\/(\d+)$/);
  if (uM && m === "PUT") {
    if (!admin) return err("Só o admin", 403);
    const id = +uM[1];
    if (id === user.id && (body.active === 0 || (body.role && body.role !== "admin"))) return err("Não podes desativar ou despromover a tua própria conta");
    const sets = [], b = [];
    if (body.name) { sets.push("name=?"); b.push(String(body.name).trim()); }
    if (body.pin) { if (!/^\d{4,8}$/.test(body.pin)) return err("PIN 4–8 dígitos"); sets.push("pin_hash=?"); b.push(await sha(String(body.pin))); }
    if (body.role) { sets.push("role=?"); b.push((["admin","manager"].includes(body.role) ? body.role : "seller")); }
    if (body.commission != null) { sets.push("commission=?"); b.push(Math.max(0, +body.commission || 0)); }
    if (body.active != null) { sets.push("active=?"); b.push(body.active ? 1 : 0); }
    if (!sets.length) return err("Nada para alterar");
    try { await db.prepare(`UPDATE users SET ${sets.join(",")} WHERE id=?`).bind(...b, id).run(); }
    catch (e) { return err("Esse PIN já está a ser usado. Escolhe outro."); }
    if (body.active === 0 || body.pin) await db.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(id).run();
    return json({ ok: true });
  }

  // Caixa (cash na loja)
  if (path === "/cash" && m === "GET") {
    const last = await db.prepare(`SELECT c.*, u.name AS by_name FROM cash_moves c LEFT JOIN users u ON u.id=c.user_id WHERE c.type='recolha' ORDER BY c.id DESC LIMIT 1`).first();
    const since = last ? last.ts : 0;
    const inn = await db.prepare(`SELECT COALESCE(SUM(subtotal+delivery),0) t, COUNT(*) n FROM sales WHERE void=0 AND payment='Cash'`).first();
    const exp = await db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM expenses WHERE paid_cash=1`).first();
    const mv = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='recolha' THEN -amount ELSE amount END),0) t FROM cash_moves`).first();
    const balance = inn.t - exp.t + mv.t;
    const sales = (await db.prepare(`SELECT s.id,s.day,s.ts,s.subtotal,s.delivery,s.customer,u.name AS seller FROM sales s JOIN users u ON u.id=s.user_id WHERE s.void=0 AND s.payment='Cash' AND s.ts>? ORDER BY s.id`).bind(since).all()).results;
    const expenses = (await db.prepare(`SELECT e.id,e.day,e.ts,e.type,e.amount,e.notes,u.name AS by_name FROM expenses e LEFT JOIN users u ON u.id=e.user_id WHERE e.paid_cash=1 AND e.ts>? ORDER BY e.id`).bind(since).all()).results;
    const moves = (await db.prepare(`SELECT c.*, u.name AS by_name FROM cash_moves c LEFT JOIN users u ON u.id=c.user_id ORDER BY c.id DESC LIMIT 30`).all()).results;
    return json({ balance, since, last, sales, expenses, moves });
  }
  if (path === "/cash" && m === "POST") {
    const type = ["recolha", "ajuste", "abertura"].includes(body.type) ? body.type : "recolha";
    if (!mgr) return err("Só a gerência pode registar movimentos de caixa", 403);
    const amount = Math.round(+body.amount || 0);
    if (type !== "ajuste" && !(amount > 0)) return err("Valor inválido");
    await db.prepare(`INSERT INTO cash_moves(ts,day,type,amount,counted,expected,user_id,notes) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(Date.now(), today(), type, amount, body.counted === "" || body.counted == null ? null : Math.round(+body.counted), body.expected == null ? null : Math.round(+body.expected), user.id, (body.notes || "").slice(0, 200)).run();
    // Diferença entre contado e esperado vira ajuste, para o saldo bater com a realidade
    if (type === "recolha" && body.counted != null && body.counted !== "" && body.expected != null) {
      const dif = Math.round(+body.counted) - Math.round(+body.expected);
      if (dif) await db.prepare(`INSERT INTO cash_moves(ts,day,type,amount,user_id,notes) VALUES(?,?,?,?,?,?)`).bind(Date.now() - 1, today(), "ajuste", dif, user.id, "diferença na contagem").run();
    }
    return json({ ok: true });
  }

  // Definições (admin): ex. preço de artigos sem preço
  if (path === "/settings" && m === "PUT") {
    if (!admin) return err("Só o admin", 403);
    const stmts = Object.entries(body || {}).map(([k, v]) => db.prepare(`INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).bind(k, String(v)));
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true });
  }

  // Relatório por período (admin)
  if (path === "/report" && m === "GET") {
    if (!admin) return err("Só o admin", 403);
    const from = url.searchParams.get("from") || today(), to = url.searchParams.get("to") || today();
    const byDay = (await db.prepare(`SELECT day, COUNT(*) n, SUM(subtotal) total, SUM(delivery) delivery FROM sales WHERE void=0 AND day BETWEEN ? AND ? GROUP BY day ORDER BY day`).bind(from, to).all()).results;
    const top = (await db.prepare(`SELECT i.product_id, i.name, SUM(i.qty) qty, SUM(i.qty*i.unit_price) total FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.void=0 AND s.day BETWEEN ? AND ? GROUP BY i.product_id ORDER BY qty DESC LIMIT 20`).bind(from, to).all()).results;
    const bySeller = (await db.prepare(`SELECT u.name, COUNT(*) n, SUM(s.subtotal) total FROM sales s JOIN users u ON u.id=s.user_id WHERE s.void=0 AND s.day BETWEEN ? AND ? GROUP BY u.id ORDER BY total DESC`).bind(from, to).all()).results;
    return json({ from, to, byDay, top, bySeller });
  }

  return err("Rota desconhecida", 404);
}
