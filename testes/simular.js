// Simula o bot rodando de INICIO ate FIM, executando a AGENDA real em cada horario.
// - Relogio do bot (luxon) e voltado no tempo
// - Envios de WhatsApp sao interceptados e gravados
// - Respostas do Moodle sao filtradas para esconder o que ainda nao existia na data simulada
//
// Usa a conta do moodle/.env e faz requisicoes REAIS (somente leitura) ao Moodle. Nada e enviado
// no WhatsApp e o cache/log reais sao restaurados ao final.
//
// uso: npm run simular -- [dias=7] [saida=testes/saida-simulacao.txt]
//      SEM_CENARIOS=1 npm run simular   (so dados reais, sem os cenarios injetados)
const fs   = require("fs");
const path = require("path");
const BASE = path.join(__dirname, "..") + "/";
const M    = BASE + "comandos/moodle/";
const { Settings, DateTime } = require("luxon");

const ZONA   = "America/Sao_Paulo";
const DIAS   = Number(process.argv[2]) || 7;
const SAIDA  = process.argv[3] || path.join(__dirname, "saida-simulacao.txt");
const FIM    = DateTime.now().setZone(ZONA);
const INICIO = FIM.minus({ days: DIAS }).startOf("day").set({ hour: 5, minute: 59 });

// Cache e log do bot isolados: guarda os reais e comeca do zero
const CACHE = BASE + "moodle/cache.json", LOGF = BASE + "moodle/logs.txt";
const bak = { cache: fs.readFileSync(CACHE, "utf8"), log: fs.existsSync(LOGF) ? fs.readFileSync(LOGF, "utf8") : "" };
fs.writeFileSync(CACHE, "{}");
const restaurar = () => { fs.writeFileSync(CACHE, bak.cache); fs.writeFileSync(LOGF, bak.log); };
process.on("exit", restaurar);

let simMs = INICIO.toMillis();
Settings.now = () => simMs;
const nowS = () => simMs / 1000;

const out = [];
const registrar = s => { out.push(s); };
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (c, ...r) => { registrar(String(c).trimEnd()); return true; };

// --- Intercepta envios ---
const notif = require(M + "notificacoes");
const cfg   = require(M + "config");
const rotulo = jid => jid === cfg.ADMIN ? "ADMIN" : jid;
notif.wa = async (jid, texto) => { registrar(`\n>>> WHATSAPP [${rotulo(jid)}] ${DateTime.fromMillis(simMs).setZone(ZONA).toFormat("dd/MM HH:mm")}\n${texto}\n<<<`); return true; };
notif.broadcast = async (texto, destinos) => notif.wa(destinos.map(rotulo).join(","), texto);
notif.waArquivo = async (jid, b, m, nome, legenda) => {
    const previa = m === "text/plain" ? `\n   (${b.length} bytes) ${b.toString("utf8").slice(0, 120).replace(/\n/g, " ")}...` : "";
    registrar(`>>> ARQUIVO [${rotulo(jid)}] ${nome}${legenda ? ` | legenda: "${legenda}"` : ""}${previa}`);
    return true;
};
notif.broadcastArquivo = async (b, m, nome, d, legenda) => notif.waArquivo(d.map(rotulo).join(","), b, m, nome, legenda);
notif.tg = async t => registrar(`>>> TELEGRAM ${t}`);
const http = require(M + "http");
http.baixarArquivoComRetry = async url => ({ buffer: Buffer.from("x"), mimetype: "application/pdf" });

// --- Filtra respostas do Moodle pela data simulada ---
const api = require(M + "api");
const orig = { ...api };
// ---- Cenarios injetados sobre os dados reais ----
const ts = iso => DateTime.fromISO(iso, { zone: ZONA }).toSeconds();
// Cenarios montados sobre os dados reais da conta original (cmids da turma de ADS 2026.2).
// Em outra conta os cmids nao existem e os cenarios simplesmente nao tem efeito.
const CENARIOS = process.env.SEM_CENARIOS ? {} : {
    // Prazo estendido: PLANO DE OFICINAS (cmid 30871) vencia 04/10; em 05/10 08h o professor estende para 07/10
    extensao: { cmid: 30871, quando: ts("2026-10-05T08:00"), novoPrazo: ts("2026-10-07T23:59") },
    // Modulos que "passam a existir" no meio da semana (cmid -> momento de criacao)
    criados:  { 31065: ts("2026-10-05T10:00"), 31321: ts("2026-10-07T21:06"), 31352: ts("2026-10-08T22:00") },
    // Aviso de professor: a discussao mais recente passa a ter sido criada em 07/10 08h
    aviso:    ts("2026-10-07T08:00"),
    // Tarefa criada oculta e liberada depois (data de modificacao continua antiga): PI #02 so aparece em 06/10 10h
    liberadas: { 31224: ts("2026-10-06T10:00") },
    // Bot desligado (queda de energia, PC desligado...): de 08/10 00h ate 08/10 15h
    desligado: [ts("2026-10-08T00:00"), ts("2026-10-08T15:00")],
};
// Bot desligado num periodo qualquer, mesmo sem os cenarios: DESLIGADO=2026-10-19T00:00,2026-10-19T19:00
if (process.env.DESLIGADO) CENARIOS.desligado = process.env.DESLIGADO.split(",").map(ts);

api.buscarAtividades = async ids => {
    const d = await orig.buscarAtividades(ids);
    for (const c of d.courses || []) {
        c.assignments = (c.assignments || []).filter(a => a.timemodified <= nowS() && !((CENARIOS.liberadas?.[a.cmid] || 0) > nowS()));
        const ex = CENARIOS.extensao;
        for (const a of c.assignments)
            if (ex && a.cmid === ex.cmid && nowS() >= ex.quando) { a.duedate = ex.novoPrazo; a.timemodified = ex.quando; }
    }
    return d;
};
const ehFuturo = m => (CENARIOS.criados?.[m.id] || 0) > nowS();

// Modulos criados durante o periodo simulado: o Moodle nao informa a data de criacao, entao estimamos pela
// ultima edicao (core_course_get_updates_since) dos modulos com ID maior que o de todos os que nao mudaram.
const criacaoEstimada = new Map(); // courseid -> Map(cmid -> momento)
async function estimarCriacao(courseid, modulos) {
    if (criacaoEstimada.has(courseid)) return criacaoEstimada.get(courseid);
    const ultimaEdicao = new Map();
    try {
        for (const i of await orig.buscarAlteracoesDesde(courseid, INICIO.toSeconds()))
            for (const u of i.updates || []) if (u.name === "configuration" && u.timeupdated)
                ultimaEdicao.set(i.id, Math.max(ultimaEdicao.get(i.id) || 0, u.timeupdated));
    } catch {}
    const limite = Math.max(0, ...modulos.filter(m => m.modname !== "assign" && !ultimaEdicao.has(m.id)).map(m => m.id));
    const mapa = new Map([...ultimaEdicao].filter(([id]) => id > limite));
    criacaoEstimada.set(courseid, mapa);
    return mapa;
}
api.buscarModulos = async id => {
    const secoes = await orig.buscarModulos(id);
    const criacao = await estimarCriacao(id, secoes.flatMap(s => s.modules || []));
    return secoes.map(s => ({ ...s, modules: (s.modules || []).filter(m => !ehFuturo(m) && !((criacao.get(m.id) || 0) > nowS())) }));
};
// "O professor mexeu nos ultimos 30 min?" considerando so as edicoes ate o momento simulado
api.buscarAlteracoesDesde = async (id, since) => (await orig.buscarAlteracoesDesde(id, since))
    .map(i => ({ ...i, updates: (i.updates || []).filter(u => u.timeupdated && u.timeupdated >= since && u.timeupdated <= nowS()) }))
    .filter(i => i.updates.length);
// O calendario e historico, mas reflete a extensao do cenario (evento de prazo muda de dia)
api.buscarAulasCalendario = async (a, m, d) => {
    const ev = await orig.buscarAulasCalendario(a, m, d);
    const ex = CENARIOS.extensao;
    if (!ex || nowS() < ex.quando) return ev;
    const semAntigo = ev.filter(e => !(e.modulename === "assign" && e.instance === ex.cmid));
    const dia = DateTime.fromSeconds(ex.novoPrazo).setZone(ZONA);
    if (dia.day === d && dia.month === m) {
        const base = (await orig.buscarAulasCalendario(2026, 10, 4)).find(e => e.instance === ex.cmid);
        if (base) semAntigo.push({ ...base, timestart: ex.novoPrazo });
    }
    return semAntigo;
};
let avisoAlterado = null;
api.buscarDiscussoes = async id => {
    const ds = await orig.buscarDiscussoes(id);
    if (CENARIOS.aviso && !avisoAlterado && ds.length) avisoAlterado = ds[0].discussion;
    return ds.map(d => d.discussion === avisoAlterado ? { ...d, created: CENARIOS.aviso } : d).filter(d => d.created <= nowS());
};
api.buscarNotasCurso = async id => (await orig.buscarNotasCurso(id)).map(it =>
    it.gradedategraded > nowS() ? { ...it, graderaw: null, gradedategraded: null } : it);

// Carrega o resto so depois dos patches (os modulos desestruturam as funcoes ao carregar)
const V = require(M + "verificacoes");
const { AGENDA, AO_INICIAR } = require(M + "rotina");

(async () => {
    const t0 = Date.now();
    registrar(`##### SIMULACAO ${INICIO.toFormat("dd/MM HH:mm")} -> ${FIM.toFormat("dd/MM HH:mm")}`);
    registrar(`##### Bot iniciado em ${INICIO.toFormat("dd/MM HH:mm")}`);
    for (const [, fn, h] of AO_INICIAR) if (DateTime.fromMillis(simMs).setZone(ZONA).hour >= h) await fn();
    let religou = false;

    for (let dia = INICIO.startOf("day"); dia <= FIM; dia = dia.plus({ days: 1 })) {
        registrar(`\n=================== ${dia.setLocale("pt-BR").toFormat("cccc dd/MM")} ===================`);
        for (const [h, m, nome, fn] of AGENDA) {
            const t = dia.set({ hour: h, minute: m });
            if (t < INICIO || t > FIM) continue;
            const [off, on] = CENARIOS.desligado || [];
            if (off && t.toSeconds() >= off && t.toSeconds() < on) continue;
            if (off && t.toSeconds() >= on && !religou) {
                religou = true; simMs = on * 1000;
                registrar(`
##### Bot religado em ${DateTime.fromMillis(simMs).setZone(ZONA).toFormat("dd/MM HH:mm")} (estava desligado desde ${DateTime.fromSeconds(off).setZone(ZONA).toFormat("dd/MM HH:mm")})`);
                for (const [, f, h] of AO_INICIAR) if (DateTime.fromMillis(simMs).setZone(ZONA).hour >= h) await f();
            }
            simMs = t.toMillis();
            try { await fn(); }
            catch (e) { registrar(`!!! ERRO em [${nome}] ${e.stack}`); }
        }
    }
    registrar(`\n##### Fim. Tempo real gasto: ${Math.round((Date.now() - t0) / 1000)}s`);
    fs.writeFileSync(SAIDA, out.join("\n"));
    restaurar();
    origWrite(`ok -> ${SAIDA}\n`);
})().catch(e => { origWrite("FALHA " + e.stack + "\n"); restaurar(); process.exit(1); });
