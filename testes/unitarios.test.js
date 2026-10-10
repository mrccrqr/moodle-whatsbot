'use strict';

// Testes rapidos e offline (nao acessam Moodle nem WhatsApp): npm test

const test   = require("node:test");
const assert = require("node:assert/strict");

// Valores minimos para o config.js carregar sem o moodle/.env
process.env.MOODLE_USER ||= "teste";
process.env.MOODLE_PASS ||= "teste";
process.env.ADMIN_JID   ||= "5500000000000@s.whatsapp.net";

const { DateTime } = require("luxon");
const ZONA = "America/Sao_Paulo";
const ts   = iso => DateTime.fromISO(iso, { zone: ZONA }).toSeconds();
const DIA  = 86400;

const { calcularMarcos, textoFalta, decidirLembrete } = require("../comandos/moodle/lembretes");
const { fmtData, normalizarNomeDisciplina, limparHTML } = require("../comandos/moodle/formatacao");

process.env.DIGITANDO_MS = "0"; // sem espera do "digitando..." nos testes

// Nao gravar no moodle/.env nem no cache real durante os testes
const configModulo = require("../comandos/moodle/config");
configModulo.salvarDestinos = () => {};
require("../comandos/moodle/cache").salvarCache = () => {};

// Intercepta envios antes de carregar os modulos que os usam
const notif   = require("../comandos/moodle/notificacoes");
const enviados = [];
notif.wa               = async (jid, texto) => { enviados.push({ tipo: "texto", jid, texto }); return true; };
notif.broadcastArquivo = async (buffer, mime, nome, destinos, legenda) => { enviados.push({ tipo: "arquivo", nome, legenda, texto: buffer.toString("utf8") }); };

const { enviarTextoOuArquivo, LIMITE_TEXTO } = require("../comandos/moodle/envios");
const { montarMsgVencimentos, montarMsgLinks, nomeDoEvento, diasAte } = require("../comandos/moodle/verificacoes");

// ---------------------------------------------------------------- lembretes

test("lembretes: prazos curtos nao recebem lembrete intermediario", () => {
    assert.deepEqual(calcularMarcos(0, 2 * DIA), []);
    assert.deepEqual(calcularMarcos(0, 3 * DIA), []);
});

test("lembretes: 1 mes de prazo -> um lembrete com 2 semanas restantes", () => {
    assert.deepEqual(calcularMarcos(0, 30 * DIA), [14]);
});

test("lembretes: prazos longos recebem mais lembretes, em dias redondos e decrescentes", () => {
    assert.deepEqual(calcularMarcos(0, 7 * DIA), [3]);
    assert.deepEqual(calcularMarcos(0, 60 * DIA), [42, 21]);
    assert.deepEqual(calcularMarcos(0, 120 * DIA), [90, 60, 30]);
    for (const d of [4, 5, 10, 21, 45, 90, 365]) {
        const m = calcularMarcos(0, d * DIA);
        assert.ok(m.length <= 3, `${d} dias: no maximo 3 lembretes`);
        assert.ok(m.every(x => x >= 2 && x <= d - 1), `${d} dias: nunca no lancamento nem no ultimo dia`);
        assert.deepEqual(m, [...m].sort((a, b) => b - a));
    }
});

test("lembretes: texto amigavel", () => {
    assert.equal(textoFalta(1), "amanha");
    assert.equal(textoFalta(14), "2 semanas");
    assert.equal(textoFalta(7), "1 semana");
    assert.equal(textoFalta(30), "1 mes");
    assert.equal(textoFalta(60), "2 meses");
    assert.equal(textoFalta(5), "5 dias");
});

test("lembretes: envia no marco, nao repete, recupera dia perdido e reinicia se o prazo mudar", () => {
    const base = { inicioTs: 0, prazoTs: 30 * DIA }; // marco: 14 dias

    let r = decidirLembrete({ ...base, diasRestantes: 20, estado: undefined });
    assert.equal(r.enviar, false);

    r = decidirLembrete({ ...base, diasRestantes: 14, estado: r.novoEstado });
    assert.equal(r.enviar, true);

    r = decidirLembrete({ ...base, diasRestantes: 13, estado: r.novoEstado });
    assert.equal(r.enviar, false, "nao repete o mesmo marco");

    // Bot desligado no dia 14: avisa no proximo dia em que rodar (ate 2 dias de atraso)
    r = decidirLembrete({ ...base, diasRestantes: 12, estado: undefined });
    assert.equal(r.enviar, true);

    // Marco que passou ha muito tempo (ex.: primeira execucao do bot): so marca, nao envia
    r = decidirLembrete({ ...base, diasRestantes: 5, estado: undefined });
    assert.equal(r.enviar, false);
    assert.deepEqual(r.novoEstado.enviados, [14]);

    // Prazo estendido: estado anterior nao vale mais
    const estendido = { inicioTs: 0, prazoTs: 40 * DIA };
    r = decidirLembrete({ ...estendido, diasRestantes: 21, estado: { prazo: 30 * DIA, enviados: [14] } });
    assert.equal(r.enviar, true);

    // Dia do vencimento e responsabilidade do "vence hoje"
    assert.equal(decidirLembrete({ ...base, diasRestantes: 0, estado: undefined }).enviar, false);
});

test("lembretes: dias ate o prazo usam o calendario de Sao Paulo", () => {
    const now = DateTime.fromISO("2026-10-08T12:00", { zone: ZONA });
    assert.equal(diasAte(ts("2026-10-22T23:59"), now), 14);
    assert.equal(diasAte(ts("2026-10-09T23:59"), now), 1);
    assert.equal(diasAte(ts("2026-10-16T00:00"), now), 7, "meia-noite conta como o dia anterior");
});

// ---------------------------------------------------------------- mensagens

test("vencimentos: prazo estendido e escrito em primeira pessoa", () => {
    const msg = montarMsgVencimentos([{
        curso: "Banco de Dados II (2026.2)", nome: "Atividade II", ts: ts("2026-10-07T23:59"),
        link: "https://x", estendidoDe: ts("2026-10-04T23:59"),
    }]);
    assert.match(msg, /PRAZO ESTENDIDO — ATIVIDADE VENCE HOJE/);
    assert.match(msg, /Ja avisei dessa atividade antes: o prazo era 04\/10 as 23h59 e foi estendido/);
});

test("vencimentos: varias atividades viram uma mensagem so", () => {
    const item = (curso, nome) => ({ curso, nome, ts: ts("2026-10-07T23:59"), link: `https://x/${nome}`, estendidoDe: null });
    const msg = montarMsgVencimentos([item("Banco de Dados II (2026.2)", "A"), item("Programação Web II (2026.2)", "B")]);
    assert.match(msg, /^\*2 ATIVIDADES VENCEM HOJE\*/);
    assert.match(msg, /Banco de Dados II: A/);
    assert.match(msg, /Programação Web II: B/);
});

test("links: agrupados por disciplina, com a URL externa", () => {
    const link = (curso, nome, url) => ({ curso: { fullname: curso }, m: { name: nome, url: "https://moodle/x", contents: [{ fileurl: url }] } });
    const msg = montarMsgLinks([
        link("Banco de Dados II (2026.2)", "Aula 07", "https://eduplay/1"),
        link("Programação Web II (2026.2)", "Aula VI", "https://eduplay/2"),
    ]);
    assert.match(msg, /^\*2 NOVOS LINKS\*/);
    assert.match(msg, /\*Banco de Dados II\*\n- Aula 07\n  https:\/\/eduplay\/1/);
});

test("calendario: nome limpo do evento de prazo", () => {
    assert.equal(nomeDoEvento("Término de Atividade III – Quiz"), "Atividade III – Quiz");
    assert.equal(nomeDoEvento("PLANO DE OFICINAS está marcado(a) para esta data"), "PLANO DE OFICINAS");
    assert.equal(nomeDoEvento("Estruturas de Armazenamento é devido"), "Estruturas de Armazenamento");
});

test("formatacao: datas, nomes de disciplina e HTML", () => {
    assert.equal(fmtData(ts("2026-10-22T23:59")), "22/10 as 23h59");
    assert.equal(fmtData(ts("2026-10-16T00:00")), "16/10 a meia-noite");
    assert.equal(fmtData(null), "Sem prazo definido");
    assert.equal(normalizarNomeDisciplina("Gestão da Educação  (2026.1)"), "Gestão da Educação");
    assert.equal(limparHTML("<p>Oi&nbsp;turma</p><ul><li>item</li></ul>"), "Oi turma\n- item");
});

// ---------------------------------------------------------------- textos longos

test("textos longos viram arquivo .txt; curtos vao direto", async () => {
    enviados.length = 0;
    await enviarTextoOuArquivo(["grupo"], "Descricao", "curto");
    assert.equal(enviados[0].tipo, "texto");
    assert.match(enviados[0].texto, /Descricao:\n\n```\ncurto\n```/);

    enviados.length = 0;
    const longo = "x".repeat(LIMITE_TEXTO + 1);
    await enviarTextoOuArquivo(["grupo"], "Descricao", longo);
    assert.equal(enviados[0].tipo, "arquivo");
    assert.equal(enviados[0].nome, "descrição.txt");
    assert.equal(enviados[0].texto, longo);
    assert.match(enviados[0].legenda, /texto longo/);
});

// ---------------------------------------------------------------- telefone / WhatsApp

const { variantesNumero, paraJid, mesmoNumero } = require("../utils/telefone");

test("telefone: aceita so DDD + numero e gera as duas variantes do nono digito", () => {
    assert.deepEqual(variantesNumero("77998765432"),   ["5577998765432", "557798765432"]);
    assert.deepEqual(variantesNumero("7798765432"),    ["557798765432", "5577998765432"]);
    assert.deepEqual(variantesNumero("(77) 99876-5432"), ["5577998765432", "557798765432"]);
    assert.deepEqual(variantesNumero("+55 77 99876-5432"), ["5577998765432", "557798765432"]);
    assert.deepEqual(variantesNumero("557798765432@s.whatsapp.net"), ["557798765432", "5577998765432"]);
    assert.deepEqual(variantesNumero("7734241234"), ["557734241234"], "fixo (comeca com 2-5) nao ganha 9");
});

test("telefone: JID padrao; grupos e LIDs passam direto", () => {
    assert.equal(paraJid("7798765432"), "557798765432@s.whatsapp.net");
    assert.equal(paraJid("120363000000000000@g.us"), "120363000000000000@g.us");
    assert.equal(paraJid("123456789@lid"), "123456789@lid");
    assert.equal(paraJid(""), null);
});

test("telefone: mesmo numero com ou sem o nono digito", () => {
    assert.ok(mesmoNumero("557798765432@s.whatsapp.net", "77998765432"));
    assert.ok(mesmoNumero("5577998765432", "7798765432"));
    assert.ok(!mesmoNumero("557798765432", "557798765433"));
    assert.ok(!mesmoNumero("123@lid", "557798765432"));
});

test("contatos: le nome e ID do WhatsApp do cartao de contato (waid), um ou varios", () => {
    const { _contatosDaMensagem: ler } = require("../comandos/destinos");
    const vcard = (nome, waid, tel) => `BEGIN:VCARD
VERSION:3.0
N:;${nome};;;
FN:${nome}
TEL;type=CELL;type=VOICE${waid ? `;waid=${waid}` : ""}:${tel}
END:VCARD`;

    assert.deepEqual(ler({ contactMessage: { displayName: "Fulano de Tal", vcard: vcard("Fulano de Tal", "557798765432", "+55 77 9876-5432") } }),
        [{ nome: "Fulano de Tal", numero: "557798765432", temWaid: true }]);

    // Contato sem WhatsApp: sem waid, fica o telefone para conferir com o WhatsApp
    assert.deepEqual(ler({ contactMessage: { displayName: "Fixo", vcard: vcard("Fixo", null, "+55 77 3424-1234") } }),
        [{ nome: "Fixo", numero: "+55 77 3424-1234", temWaid: false }]);

    const varios = ler({ contactsArrayMessage: { contacts: [
        { displayName: "A", vcard: vcard("A", "5511999990000", "+55 11 99999-0000") },
        { displayName: "B", vcard: vcard("B", "5521988880000", "+55 21 98888-0000") },
    ] } });
    assert.deepEqual(varios.map(c => c.numero), ["5511999990000", "5521988880000"]);

    assert.deepEqual(ler({ conversation: "oi" }), []);
});

test("envio humanizado: 'digitando...' antes de cada mensagem, sempre na ordem", async () => {
    const { enviarDigitando } = require("../utils/wa");
    const chamadas = [];
    const anterior = global.botAtivo;
    global.botAtivo = {
        onWhatsApp:         async () => [{ exists: true, jid: "557798765432@s.whatsapp.net" }],
        sendPresenceUpdate: async (estado, jid) => chamadas.push(`${estado}`),
        // envio com atraso aleatorio: se algo rodasse em paralelo, a ordem embaralharia
        sendMessage:        async (jid, { text }) => { await new Promise(r => setTimeout(r, Math.random() * 30)); chamadas.push(`msg:${text}`); },
    };
    try {
        const ok = await enviarDigitando("5577998765432@s.whatsapp.net", ["um", "dois", "tres"]);
        assert.equal(ok, true);
        assert.deepEqual(chamadas, [
            "composing", "paused", "msg:um",
            "composing", "paused", "msg:dois",
            "composing", "paused", "msg:tres",
        ]);
    } finally { global.botAtivo = anterior; }
});

// ---------------------------------------------------------------- comandos de destinos

test("destinos: comandos aceitam variacoes de digitacao", () => {
    const { _lerComando: ler } = require("../comandos/destinos");
    for (const t of ["/add-grupo", "/addgrupo", "/add grupo", "/Add-Grupo", "/add_grupo"]) assert.deepEqual(ler(t), { cmd: "add-grupo", arg: "" }, t);
    assert.deepEqual(ler("/add-grupo 2"), { cmd: "add-grupo", arg: "2" });
    assert.deepEqual(ler("/add-pessoa 77991234567"), { cmd: "add-pessoa", arg: "77991234567" });
    assert.deepEqual(ler("/remover 3"), { cmd: "remover", arg: "3" });
    assert.deepEqual(ler("/cancelar"), { cmd: "cancelar", arg: "" });
    for (const t of ["/grupos", "/ativar 1", "/disciplinas", "add-grupo", "oi"]) assert.equal(ler(t), null, t);
});

test("destinos: entende '2', '1 e 3', '1,3'; recusa fora da lista e texto", () => {
    const { _numerosDaResposta: nums } = require("../comandos/destinos");
    assert.deepEqual(nums("2", 3), [2]);
    assert.deepEqual(nums("1 e 3", 3), [1, 3]);
    assert.deepEqual(nums("1,3", 3), [1, 3]);
    assert.equal(nums("4", 3), null);
    assert.equal(nums("0", 3), null);
    assert.equal(nums("o primeiro", 3), null);
});

test("destinos: /add-grupo pergunta, repete se nao entender e ativa o escolhido", async () => {
    const destinos = require("../comandos/destinos");
    const { DESTINOS_GRUPO } = configModulo;
    const ADMIN = configModulo.ADMIN;
    const recebidas = [];
    const anterior = global.botAtivo;
    global.botAtivo = {
        onWhatsApp:                 async () => [{ exists: true, jid: ADMIN }],
        sendPresenceUpdate:         async () => {},
        sendMessage:                async (jid, { text }) => { recebidas.push(text); },
        groupFetchAllParticipating: async () => ({
            "1@g.us": { id: "1@g.us", subject: "Turma B" },
            "2@g.us": { id: "2@g.us", subject: "Turma A" },
        }),
    };
    const contexto = texto => ({ botWhatsApp: global.botAtivo, jid: ADMIN, jidUsuario: ADMIN, texto, textoLower: texto.toLowerCase(), msg: { key: {} } });
    const inicio = DESTINOS_GRUPO.length;
    try {
        await destinos.executar(contexto("/add-grupo"));
        assert.deepEqual(recebidas, [
            "*GRUPOS EM QUE ESTOU*\n\n1. Turma A\n2. Turma B",
            "Quais desses vc quer eu envie notificações do Moodle?",
            "Me responda com a opção desejada",
        ]);
        assert.equal(destinos.aguardandoOQue(), "a opção desejada");

        recebidas.length = 0;
        assert.equal(await destinos.onMensagem(contexto("o da turma")), true);
        assert.deepEqual(recebidas, ["Não entendi. Me responda com a opção desejada (de 1 a 2)"]);

        recebidas.length = 0;
        await destinos.onMensagem(contexto("1"));
        assert.equal(recebidas[0], "Notificações do Moodle ativadas no grupo *Turma A*");
        assert.ok(DESTINOS_GRUPO.includes("2@g.us"));
        assert.equal(destinos.aguardandoOQue(), null, "espera encerrada");

        // Fora de espera, numero solto nao faz nada
        assert.equal(await destinos.onMensagem(contexto("2")), false);
    } finally {
        global.botAtivo = anterior;
        DESTINOS_GRUPO.splice(inicio);
    }
});

test("destinos: contato sem /add-pessoa nao adiciona; com /add-pessoa adiciona", async () => {
    const destinos = require("../comandos/destinos");
    const { DESTINOS_PESSOAL, ADMIN } = configModulo;
    const recebidas = [];
    const anterior = global.botAtivo;
    global.botAtivo = {
        onWhatsApp:         async () => [{ exists: true, jid: "5511999990000@s.whatsapp.net" }],
        sendPresenceUpdate: async () => {},
        sendMessage:        async (jid, { text }) => { recebidas.push(text); },
    };
    const cartao = { contactMessage: { displayName: "Fulano", vcard: "BEGIN:VCARD\nFN:Fulano\nTEL;type=CELL;waid=5511999990000:+55 11 99999-0000\nEND:VCARD" } };
    const contexto = (texto, message) => ({ botWhatsApp: global.botAtivo, jid: ADMIN, jidUsuario: ADMIN, texto, textoLower: texto.toLowerCase(), msg: { key: {}, message } });
    const inicio = DESTINOS_PESSOAL.length;
    enviados.length = 0;
    try {
        await destinos.onMensagem(contexto("", cartao));
        assert.match(recebidas[0], /não adicionei ninguém/);
        assert.ok(!DESTINOS_PESSOAL.includes("5511999990000@s.whatsapp.net"));

        await destinos.executar(contexto("/add-pessoa"));
        await destinos.onMensagem(contexto("", cartao));
        assert.ok(DESTINOS_PESSOAL.includes("5511999990000@s.whatsapp.net"));
        assert.ok(enviados.some(e => /Fulano adicionado|SAIR/.test(e.texto)), "confirma ao admin e da boas-vindas");
    } finally {
        global.botAtivo = anterior;
        DESTINOS_PESSOAL.splice(inicio);
    }
});
