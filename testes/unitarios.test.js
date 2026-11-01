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
const { montarMsgVencimentos, nomeDoEvento, diasAte } = require("../comandos/moodle/verificacoes");
const { detectar, montarMsgNovidades, classificarPrazo } = require("../comandos/moodle/novidades");

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

// ---------------------------------------------------------------- novidades

test("novidades: classifica a mudanca de prazo", () => {
    const hoje = ts("2026-10-20T10:00");
    assert.equal(classificarPrazo(ts("2026-10-06T23:59"), ts("2026-10-28T23:59"), hoje), "reaberto");
    assert.equal(classificarPrazo(ts("2026-10-22T23:59"), ts("2026-10-28T23:59"), hoje), "estendido");
    assert.equal(classificarPrazo(ts("2026-10-28T23:59"), ts("2026-10-22T23:59"), hoje), "antecipado");
    assert.equal(classificarPrazo(null, ts("2026-10-28T23:59"), hoje), "definido");
    assert.equal(classificarPrazo(ts("2026-10-28T23:59"), ts("2026-10-01T23:59"), hoje), null, "prazo novo ja vencido: nada a avisar");
});

// Reproducao do que aconteceu em Desenvolvimento Mobile I em 19/10/2026 (dados reais do Moodle)
test("novidades: semana montada aos poucos vira uma mensagem organizada, sem ruido", () => {
    const agoraTs = ts("2026-10-20T06:00");
    const tarefa  = (id, cmid, name, due) => ({ id, cmid, name, duedate: ts(due), timemodified: 1, intro: "" });
    const cache = {
        // ja conhecidas pelo bot antes de 19/10
        assign_1: { visto: 1, duedate: ts("2026-09-07T23:59"), anexos: [] },               // antiga "Atividade 4" (sem nome guardado)
        assign_2: { visto: 1, nome: "Atividade 6 - entrega do GitHub", duedate: ts("2026-09-28T23:59"), anexos: [] },
        assign_3: { visto: 1, nome: "Local de envio da atividade 7", duedate: ts("2026-10-06T23:59"), anexos: [] },
    };
    const tarefas = [
        tarefa(1, 30089, "Atividade 9 - Envie o link do código da semana no Github", "2026-10-26T23:59"), // reaproveitou a 4
        tarefa(2, 30525, "Atividade 6 - entrega do GitHub", "2026-10-28T23:59"),                         // reaberta
        tarefa(3, 30735, "Local de envio da atividade 7", "2026-10-28T23:59"),                           // reaberta
        tarefa(4, 31001, "Local de envio da atividade 8", "2026-10-26T23:59"),                           // liberada (nova)
        tarefa(5, 31596, "Atividade 4 - Envie o link do código da semana no Github", "2026-09-07T23:59"), // copia da antiga
    ];
    const mod = (id, modname, name, extra = {}) => ({ id, modname, name, url: `https://moodle/${id}`, dates: [], ...extra });
    const modulos = [
        mod(31587, "page", "Agenda da Semana 6"),
        mod(31591, "resource", "Programação assíncrona"),
        mod(31594, "url", "Vídeoaula - exemplo programação síncrona", { contents: [{ fileurl: "https://www.youtube.com/watch?v=Qa7zno" }] }),
        mod(31599, "url", "Videoaula: Orientação a Objetos em Dart (copiado)", { contents: [{ fileurl: "https://youtu.be/x" }] }),
    ];

    const r = detectar({ tarefas, modulos, cache, agoraTs });

    assert.deepEqual(r.atividades.map(a => a.nome), [
        "Atividade 9 - Envie o link do código da semana no Github",   // reaproveitada = nova (nao "prazo estendido")
        "Local de envio da atividade 8",
    ]);
    assert.deepEqual(r.prazos.map(p => [p.nome, p.tipo]), [
        ["Atividade 6 - entrega do GitHub", "reaberto"],
        ["Local de envio da atividade 7", "reaberto"],
    ]);
    assert.deepEqual(r.materiais.map(m => [m.nome, m.rotulo]), [
        ["Agenda da Semana 6", "página"],
        ["Programação assíncrona", "arquivo"],
        ["Vídeoaula - exemplo programação síncrona", "vídeo"],
    ], "rascunho (copiado) fica de fora");
    assert.ok(r.silencio.some(([k]) => k === "assign_5"), "copia com prazo vencido: so registra, nao anuncia");

    const msg = montarMsgNovidades("Desenvolvimento Mobile I", r);
    const esperado = [
        "*NOVIDADES EM DESENVOLVIMENTO MOBILE I*",
        "",
        "*Atividades novas*",
        "- Atividade 9 - Envie o link do código da semana no Github",
        "  Vence 26/10 as 23h59",
        "  https://moodle4.uesb.br/mod/assign/view.php?id=30089",
        "",
        "- Local de envio da atividade 8",
        "  Vence 26/10 as 23h59",
        "  https://moodle4.uesb.br/mod/assign/view.php?id=31001",
        "",
        "*Prazos reabertos*",
        "- Atividade 6 - entrega do GitHub: até 28/10 as 23h59 (tinha encerrado em 28/09)",
        "  https://moodle4.uesb.br/mod/assign/view.php?id=30525",
        "",
        "- Local de envio da atividade 7: até 28/10 as 23h59 (tinha encerrado em 06/10)",
        "  https://moodle4.uesb.br/mod/assign/view.php?id=30735",
        "",
        "*Materiais*",
        "- Agenda da Semana 6 (página)",
        "  https://moodle/31587",
        "",
        "- Programação assíncrona (arquivo)",
        "  https://moodle/31591",
        "",
        "- Vídeoaula - exemplo programação síncrona (vídeo)",
        "  https://www.youtube.com/watch?v=Qa7zno",
    ].join("\n");
    assert.equal(msg, esperado);
});

test("novidades: rascunho renomeado depois e anunciado com o nome final", () => {
    const agoraTs = ts("2026-10-20T06:00");
    const m = (name) => ({ id: 1, modname: "resource", name, url: "https://moodle/1", dates: [] });
    assert.equal(detectar({ tarefas: [], modulos: [m("Slides (copiado)")], cache: {}, agoraTs }).materiais.length, 0);
    assert.deepEqual(detectar({ tarefas: [], modulos: [m("Slides aula 7")], cache: {}, agoraTs }).materiais.map(x => x.nome), ["Slides aula 7"]);
});

test("novidades: prazo estendido de atividade ainda aberta continua sendo 'estendido'", () => {
    const agoraTs = ts("2026-10-20T06:00");
    const r = detectar({
        tarefas: [{ id: 1, cmid: 9, name: "Trabalho", duedate: ts("2026-10-30T23:59"), timemodified: 1 }],
        modulos: [], agoraTs,
        cache: { assign_1: { visto: 1, nome: "Trabalho", duedate: ts("2026-10-22T23:59"), anexos: [] } },
    });
    assert.deepEqual(r.prazos.map(p => p.tipo), ["estendido"]);
    assert.ok(montarMsgNovidades("Web II", r).includes("*Prazo estendido*\n- Trabalho: agora vence 30/10 as 23h59 (antes: 22/10 as 23h59)"));
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
        assert.ok(enviados.some(e => e.jid === ADMIN && e.texto === "Pronto, Fulano vai receber atualizações do Moodle a partir de agora"), "confirma ao admin");
        assert.ok(!enviados.some(e => e.jid !== ADMIN), "nada e enviado para a pessoa adicionada");
    } finally {
        global.botAtivo = anterior;
        DESTINOS_PESSOAL.splice(inicio);
    }
});

// ---------------------------------------------------------------- acesso ao Moodle (saude.js)

test("acesso ao Moodle: avisa uma vez quando cai (dizendo se e bloqueio) e uma vez quando volta", async () => {
    const { Settings } = require("luxon");
    const saude = require("../comandos/moodle/saude");
    const cache = require("../comandos/moodle/cache").getCache();
    const anterior = { now: Settings.now, teste: saude.testarDoBrasil, estado: cache._acessoMoodle };
    const t0 = ts("2026-10-23T16:30");
    let agoraS = t0;
    Settings.now = () => agoraS * 1000;
    saude.testarDoBrasil = async () => "ok"; // responde do Brasil -> e bloqueio do servidor do bot
    delete cache._acessoMoodle;
    let recuperou = 0;
    saude.aoVoltar(async () => { recuperou++; });
    enviados.length = 0;
    const msgs = () => enviados.map(e => e.texto);
    try {
        await saude.registrarFalha();                       // 16:30 primeira falha
        assert.equal(saude.semAcesso(), false);
        agoraS = t0 + 10 * 60; await saude.registrarFalha(); // 16:40
        assert.equal(saude.semAcesso(), true, "depois de 2 min, desiste rapido");
        assert.deepEqual(msgs(), [], "instabilidade de 10 min: ninguem e avisado");

        agoraS = t0 + 31 * 60; await saude.registrarFalha(); // 17:01 -> 31 min sem acesso
        assert.equal(msgs().length, 1);
        assert.match(msgs()[0], /^Não consigo acessar o Moodle desde 23\/10 às 16:30, mas ele está no ar/);
        assert.match(msgs()[0], /bloqueando o acesso do servidor do bot/);

        for (const h of [1, 5, 20]) { agoraS = t0 + h * 3600; await saude.registrarFalha(); }
        assert.equal(msgs().length, 1, "continua fora: nao repete o aviso");

        agoraS = ts("2026-10-24T16:00"); await saude.registrarSucesso();
        assert.equal(msgs().length, 2);
        assert.equal(msgs()[1], "O acesso ao Moodle voltou. Fiquei sem acesso de 23/10 às 16:30 até 24/10 às 16:00. Já conferi o que mudou nesse período.");
        assert.equal(recuperou, 1, "confere o que mudou quando volta");

        await saude.registrarSucesso();
        assert.equal(msgs().length, 2, "sucesso normal nao gera mensagem");
        assert.equal(saude.semAcesso(), false);
    } finally {
        Settings.now = anterior.now;
        saude.testarDoBrasil = anterior.teste;
        saude.aoVoltar(null);
        if (anterior.estado) cache._acessoMoodle = anterior.estado; else delete cache._acessoMoodle;
    }
});

test("acesso ao Moodle: queda curta nao gera nenhum aviso, nem na volta", async () => {
    const { Settings } = require("luxon");
    const saude = require("../comandos/moodle/saude");
    const cache = require("../comandos/moodle/cache").getCache();
    const anterior = { now: Settings.now, estado: cache._acessoMoodle };
    let agoraS = ts("2026-10-23T10:00");
    Settings.now = () => agoraS * 1000;
    delete cache._acessoMoodle;
    enviados.length = 0;
    try {
        await saude.registrarFalha();
        agoraS += 20 * 60; await saude.registrarFalha();
        agoraS += 5 * 60;  await saude.registrarSucesso();
        assert.deepEqual(enviados, []);
    } finally {
        Settings.now = anterior.now;
        if (anterior.estado) cache._acessoMoodle = anterior.estado; else delete cache._acessoMoodle;
    }
});

test("acesso ao Moodle: fora do ar de verdade (nao responde nem do Brasil)", async () => {
    const { Settings } = require("luxon");
    const saude = require("../comandos/moodle/saude");
    const cache = require("../comandos/moodle/cache").getCache();
    const anterior = { now: Settings.now, teste: saude.testarDoBrasil, estado: cache._acessoMoodle };
    let agoraS = ts("2026-10-23T10:00");
    Settings.now = () => agoraS * 1000;
    saude.testarDoBrasil = async () => "falha";
    delete cache._acessoMoodle;
    enviados.length = 0;
    try {
        await saude.registrarFalha();
        agoraS += 40 * 60; await saude.registrarFalha();
        assert.deepEqual(enviados.map(e => e.texto), ["O Moodle está fora do ar desde 23/10 às 10:00 (não responde nem a partir do Brasil). Aviso aqui quando voltar."]);
    } finally {
        Settings.now = anterior.now;
        saude.testarDoBrasil = anterior.teste;
        if (anterior.estado) cache._acessoMoodle = anterior.estado; else delete cache._acessoMoodle;
    }
});

// ---------------------------------------------------------------- acesso ao Moodle (direto / repasse / proxy)

test("acesso: padrao direto; repasse e proxy pelo .env; desligar sem apagar a URL", () => {
    const { configAcesso } = require("../utils/acessoMoodle");
    const URL_R = "https://abc123.execute-api.sa-east-1.amazonaws.com/";

    const d = configAcesso({});
    assert.equal(d.modo, "direto");
    assert.equal(d.apiHost, "moodle4.uesb.br");

    const r = configAcesso({ MOODLE_ACESSO: "repasse", MOODLE_REPASSE_URL: URL_R });
    assert.equal(r.modo, "repasse");
    assert.equal(r.apiHost, "abc123.execute-api.sa-east-1.amazonaws.com", "chamadas saem pelo repasse");
    assert.equal(r.host, "moodle4.uesb.br", "links para os alunos continuam no Moodle");

    const off = configAcesso({ MOODLE_ACESSO: "direto", MOODLE_REPASSE_URL: URL_R });
    assert.equal(off.apiHost, "moodle4.uesb.br", "MOODLE_ACESSO=direto desliga o repasse sem apagar a URL");

    const antigo = configAcesso({ MOODLE_API_HOST: "abc123.execute-api.sa-east-1.amazonaws.com" });
    assert.equal(antigo.modo, "repasse", ".env antigo (MOODLE_API_HOST) continua funcionando");

    const p = configAcesso({ MOODLE_ACESSO: "proxy", MOODLE_PROXY: "socks5://127.0.0.1:1080" });
    assert.equal(p.modo, "proxy");
    assert.ok(p.agente, "proxy SOCKS configurado");
    assert.equal(p.apiHost, "moodle4.uesb.br");
});

test("acesso: configuracao incompleta da erro claro na inicializacao", () => {
    const { configAcesso } = require("../utils/acessoMoodle");
    assert.throws(() => configAcesso({ MOODLE_ACESSO: "repasse" }), /MOODLE_REPASSE_URL esta vazio/);
    assert.throws(() => configAcesso({ MOODLE_ACESSO: "proxy" }), /MOODLE_PROXY esta vazio/);
    assert.throws(() => configAcesso({ MOODLE_ACESSO: "vpn" }), /MOODLE_ACESSO invalido/);
});

test("acesso: arquivo pelo repasse vai com o caminho em ?file= (API Gateway decodifica %20 e o Moodle da 400)", () => {
    const { urlViaRepasse } = require("../comandos/moodle/http");
    const H = "moodle4.uesb.br", R = "abc123.execute-api.sa-east-1.amazonaws.com";
    const url = `https://${H}/tokenpluginfile.php/CHAVE/81465/mod_assign/introattachment/0/%5BPI%5D%20Atividade%20Avaliativa%20%2303.pdf?offline=1&lang=pt_br`;

    const u = new URL(urlViaRepasse(url, H, R));
    assert.equal(u.hostname, R);
    assert.equal(u.pathname, "/tokenpluginfile.php");
    assert.equal(u.searchParams.get("file"), "/CHAVE/81465/mod_assign/introattachment/0/[PI] Atividade Avaliativa #03.pdf");
    assert.equal(u.searchParams.get("offline"), "1");
    assert.ok(!u.toString().includes(" "), "nada de espaco cru na URL");

    assert.equal(urlViaRepasse(url, H, H), url, "sem repasse: URL intacta");
    assert.equal(urlViaRepasse("https://outro.site/a b.pdf", H, R), "https://outro.site/a b.pdf", "arquivo de fora do Moodle: intacto");
});
