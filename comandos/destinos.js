'use strict';

// Quem recebe as notificacoes do Moodle: grupos e pessoas. Tudo pelo privado do bot, so o admin.
//
//   /add-grupo            mostra os grupos do bot e pergunta qual ativar; espera o numero
//   /add-grupo 2          ativa direto o grupo 2 da lista
//   /add-pessoa           espera o cartao de contato (ou o numero digitado) da pessoa
//   /add-pessoa 77991234567   adiciona direto pelo numero (DDD + numero)
//   /remover              mostra grupos e pessoas que recebem e pergunta qual remover; espera o numero
//   /remover 3            remove direto o item 3
//   /cancelar             encerra qualquer espera
//
// Esperas duram 5 minutos. Resposta que o bot nao entende -> ele pergunta de novo. Outro comando no meio
// da espera encerra a espera. Aceita variacoes de digitacao: /add-grupo, /addgrupo, /add grupo.
//
// Cartao de contato enviado SEM /add-pessoa antes nao adiciona ninguem (evita adicionar por engano,
// ex. um contato encaminhado ao bot). Quem e adicionado recebe boas-vindas e pode responder SAIR.
// Isso importa: mandar mensagem para quem nao pediu e o principal motivo de banimento de bots no WhatsApp.

const { DESTINOS_GRUPO, DESTINOS_PESSOAL, ehAdmin, salvarDestinos, ADMIN } = require("./moodle/config");
const { log }                       = require("./moodle/utils");
const { getCache, salvarCache }     = require("./moodle/cache");
const { wa }                        = require("./moodle/notificacoes");
const { resolverJid }               = require("../utils/jid");
const { enviarDigitando }           = require("../utils/wa");
const { variantesNumero, mesmoNumero, soDigitos } = require("../utils/telefone");

// /add-grupo, /addgrupo, /add grupo, /add_grupo (+ argumento opcional)
const COMANDO = /^\/(?:(add)[\s_-]*(grupo|pessoa)|(remover|cancelar))(?:\s+(.+))?$/;

function lerComando(texto) {
    const m = texto.trim().toLowerCase().match(COMANDO);
    if (!m) return null;
    return { cmd: m[1] ? `add-${m[2]}` : m[3], arg: (m[4] || "").trim() };
}

// Numeros de opcao numa resposta ("2", "1 e 3", "1,3") validos para uma lista de tamanho total
function numerosDaResposta(texto, total) {
    const nums = [...new Set((String(texto).match(/\d+/g) || []).map(Number))];
    return nums.length && nums.every(n => n >= 1 && n <= total) ? nums : null;
}

// ------------------------------------------------------------------ estado da conversa (um admin so)

const ESPERA_MS = 5 * 60 * 1000;
let pendente = null; // { tipo: "grupo" | "pessoa" | "remover", ate, opcoes }

const esperando = () => (pendente && Date.now() < pendente.ate ? pendente : null);
const esperar   = (tipo, opcoes = []) => { pendente = { tipo, ate: Date.now() + ESPERA_MS, opcoes }; };
const encerrar  = () => { pendente = null; };

// ------------------------------------------------------------------ apoio

// Nomes das pessoas adicionadas (DESTINOS guarda so o ID)
function nomes() {
    const cache = getCache();
    return cache._nomesDestinos || (cache._nomesDestinos = {});
}

const fmtNumero = jid => {
    const d = soDigitos(jid.split("@")[0]);
    const local = d.startsWith("55") ? d.slice(2) : d;
    return local.length >= 10 ? `(${local.slice(0, 2)}) ${local.slice(2, -4)}-${local.slice(-4)}` : d;
};

const rotuloPessoa = jid => nomes()[jid] ? `${nomes()[jid]} ${fmtNumero(jid)}` : fmtNumero(jid);

// Grupos em que o bot participa, em ordem estavel (nome, depois ID)
async function listarGrupos() {
    const todos = Object.values(await global.botAtivo.groupFetchAllParticipating());
    return todos.sort((a, b) => (a.subject || "").localeCompare(b.subject || "") || a.id.localeCompare(b.id));
}

// Tudo que recebe notificacoes, para o /remover
async function listarDestinos() {
    let nomesGrupos = {};
    try { nomesGrupos = Object.fromEntries((await listarGrupos()).map(g => [g.id, g.subject])); } catch {}
    return [
        ...DESTINOS_GRUPO.map(id => ({ tipo: "grupo", id, rotulo: `Grupo: ${nomesGrupos[id] || id}` })),
        ...DESTINOS_PESSOAL.map(id => ({ tipo: "pessoa", id, rotulo: `Pessoa: ${rotuloPessoa(id)}` })),
    ];
}

function alternar(lista, jid, incluir) {
    const i = lista.indexOf(jid);
    if (incluir === (i >= 0)) return false;
    if (incluir) lista.push(jid); else lista.splice(i, 1);
    salvarDestinos();
    return true;
}

// Numero -> ID real no WhatsApp (null se o numero nao tem WhatsApp)
async function idDoNumero(numero) {
    const variantes = variantesNumero(numero);
    if (!variantes.length) return null;
    try {
        const r = await global.botAtivo.onWhatsApp(...variantes);
        return r?.find(x => x.exists)?.jid || null;
    } catch { return null; }
}

async function ativarGrupo(g) {
    const mudou = alternar(DESTINOS_GRUPO, g.id, true);
    log("ok", `Grupo ativado${mudou ? "" : " (ja estava)"}: "${g.subject}" (${g.id})`);
    return mudou
        ? `Notificações do Moodle ativadas no grupo *${g.subject}*`
        : `O grupo *${g.subject}* já recebe as notificações do Moodle`;
}

async function adicionarPessoa(jid, nome) {
    if (nome) { nomes()[jid] = nome; salvarCache(); }
    if (!alternar(DESTINOS_PESSOAL, jid, true))
        return `*${rotuloPessoa(jid)}* já recebe as notificações do Moodle`;
    log("ok", `Pessoa adicionada aos destinos: ${rotuloPessoa(jid)} (${jid})`);
    if (!mesmoNumero(jid, ADMIN))
        await wa(jid,
            `Olá${nome ? `, ${nome.split(" ")[0]}` : ""}! Você foi adicionado(a) para receber por aqui as notificações do Moodle ` +
            `(atividades novas, prazos, avisos dos professores e aulas).\n\nSe não quiser receber, responda *SAIR*.`);
    return `*${rotuloPessoa(jid)}* adicionado(a). Mandei uma mensagem de boas-vindas avisando que pode responder SAIR.`;
}

function removerDestino(item) {
    alternar(item.tipo === "grupo" ? DESTINOS_GRUPO : DESTINOS_PESSOAL, item.id, false);
    log("ok", `Removido dos destinos: ${item.rotulo} (${item.id})`);
    return `${item.rotulo.replace(/^(Grupo|Pessoa): /, "")} removido(a) das notificações do Moodle`;
}

// Cartao(oes) de contato enviados ao bot: [{ nome, numero, temWaid }]
function contatosDaMensagem(m) {
    const cartoes = m?.contactMessage ? [m.contactMessage] : (m?.contactsArrayMessage?.contacts || []);
    return cartoes.map(c => {
        const vcard = c.vcard || "";
        const waid  = vcard.match(/waid=(\d+)/)?.[1];                 // ID exato do WhatsApp, quando o contato tem conta
        const tel   = vcard.match(/^TEL[^:]*:(.+)$/m)?.[1];
        return { nome: c.displayName || vcard.match(/^FN:(.+)$/m)?.[1]?.trim() || null, numero: waid || tel || null, temWaid: !!waid };
    });
}

// ------------------------------------------------------------------ fluxos

async function iniciarAddGrupo(jid) {
    const grupos = await listarGrupos();
    if (!grupos.length)
        return enviarDigitando(jid, ["Ainda não estou em nenhum grupo", "Adicione meu número ao grupo e mande /add-grupo de novo"]);
    const linhas = grupos.map((g, i) => `${i + 1}. ${g.subject}${DESTINOS_GRUPO.includes(g.id) ? "  *(ativo)*" : ""}`);
    esperar("grupo", grupos.map(g => ({ id: g.id, subject: g.subject })));
    return enviarDigitando(jid, [
        `*GRUPOS EM QUE ESTOU*\n\n${linhas.join("\n")}`,
        "Quais desses vc quer eu envie notificações do Moodle?",
        "Me responda com a opção desejada",
    ]);
}

async function iniciarRemover(jid) {
    const itens = await listarDestinos();
    if (!itens.length) return enviarDigitando(jid, ["Ninguém recebe as notificações ainda (sem destinos, elas vão só para você)"]);
    esperar("remover", itens);
    return enviarDigitando(jid, [
        `*RECEBEM AS NOTIFICAÇÕES*\n\n${itens.map((x, i) => `${i + 1}. ${x.rotulo}`).join("\n")}`,
        "Qual desses você quer remover?",
        "Me responda com a opção desejada",
    ]);
}

async function adicionarContatos(jid, contatos) {
    for (const c of contatos) {
        const id = c.numero && (c.temWaid ? await resolverJid(`${soDigitos(c.numero)}@s.whatsapp.net`) : await idDoNumero(c.numero));
        if (!id) { await wa(jid, `O contato *${c.nome || "sem nome"}* não tem WhatsApp (ou o cartão veio sem número).`); continue; }
        await wa(jid, await adicionarPessoa(id, c.nome));
    }
}

// Resposta do admin enquanto o bot espera algo. Retorna true se tratou a mensagem.
async function responderEspera(p, { jid, texto, msg }) {
    const contatos = contatosDaMensagem(msg?.message);

    if (p.tipo === "grupo" || p.tipo === "remover") {
        const nums = numerosDaResposta(texto, p.opcoes.length);
        if (!nums) {
            await enviarDigitando(jid, [`Não entendi. Me responda com a opção desejada (de 1 a ${p.opcoes.length})`]);
            return true; // continua esperando
        }
        encerrar();
        if (p.tipo === "grupo") {
            const respostas = [];
            for (const n of nums) respostas.push(await ativarGrupo(p.opcoes[n - 1]));
            return enviarDigitando(jid, [respostas.join("\n"), "Também posso enviar para pessoas individualmente: /add-pessoa"]);
        }
        return enviarDigitando(jid, [nums.map(n => removerDestino(p.opcoes[n - 1])).join("\n")]);
    }

    // pessoa: cartao de contato ou numero digitado
    if (contatos.length) { encerrar(); await adicionarContatos(jid, contatos); return true; }
    const digitos = soDigitos(texto);
    if (digitos.length >= 10 && digitos.length <= 13) {
        const id = await idDoNumero(digitos);
        if (id) { encerrar(); await wa(jid, await adicionarPessoa(id, null)); return true; }
        await enviarDigitando(jid, [`Não encontrei WhatsApp para ${texto.trim()}`, "Confira o DDD e o número, ou me envie o *contato* da pessoa"]);
        return true;
    }
    await enviarDigitando(jid, ["Não entendi. Me envie o *contato* da pessoa (clipe > Contato) ou o número com DDD"]);
    return true;
}

// ------------------------------------------------------------------ modulo

module.exports = {
    nome:  "destinos",
    match: texto => !!lerComando(texto),

    executar: async ({ botWhatsApp: bot, jid, jidUsuario, texto, msg }) => {
        if (!ehAdmin(jid, jidUsuario, msg?.key?.remoteJidAlt, msg?.key?.participantAlt)) return; // so o admin
        const { cmd, arg } = lerComando(texto);
        const estava = esperando();
        encerrar(); // qualquer comando encerra a espera anterior

        if (cmd === "cancelar")
            return enviarDigitando(jid, [estava ? "Ok, cancelado" : "Não havia nada em andamento"]);

        if (cmd === "add-grupo") {
            if (!arg) return iniciarAddGrupo(jid);
            const grupos = await listarGrupos();
            const nums = numerosDaResposta(arg, grupos.length);
            if (!nums) return iniciarAddGrupo(jid); // numero invalido: mostra a lista e pergunta
            return enviarDigitando(jid, [(await Promise.all(nums.map(n => ativarGrupo(grupos[n - 1])))).join("\n")]);
        }

        if (cmd === "add-pessoa") {
            if (!arg) {
                esperar("pessoa");
                return enviarDigitando(jid, [
                    "Agora me envie o *contato* da pessoa (clipe > Contato)",
                    "Pode ser mais de um",
                    "Vou esperar por 5 minutos",
                ]);
            }
            const id = await idDoNumero(arg);
            if (!id) return enviarDigitando(jid, [`Não encontrei WhatsApp para ${arg}`, "Confira o DDD e o número (ex.: /add-pessoa 77991234567)"]);
            return bot.sendMessage(jid, { text: await adicionarPessoa(id, null), linkPreview: false });
        }

        if (cmd === "remover") {
            if (!arg) return iniciarRemover(jid);
            const itens = await listarDestinos();
            const nums = numerosDaResposta(arg, itens.length);
            if (!nums) return iniciarRemover(jid);
            return enviarDigitando(jid, [nums.map(n => removerDestino(itens[n - 1])).join("\n")]);
        }
    },

    // Usado pelo index.js quando o admin edita uma mensagem enquanto o bot espera algo
    aguardandoOQue: () => ({ grupo: "a opção desejada", pessoa: "o contato", remover: "a opção desejada" })[esperando()?.tipo] || null,

    // Mensagens sem comando: resposta a uma espera, cartao de contato fora de hora, ou SAIR de quem recebe
    onMensagem: async ({ jid, jidUsuario, texto, textoLower, msg }) => {
        const ids = [jid, jidUsuario, msg?.key?.remoteJidAlt, msg?.key?.participantAlt];
        if (texto.trim().startsWith("/")) return false; // comandos seguem o fluxo normal

        // Pessoa que recebe as notificacoes pediu para sair
        if (textoLower === "sair") {
            const p = DESTINOS_PESSOAL.find(d => ids.some(id => id === d || mesmoNumero(id, d)));
            if (p) {
                const rotulo = rotuloPessoa(p);
                alternar(DESTINOS_PESSOAL, p, false);
                log("ok", `Pessoa saiu dos destinos (SAIR): ${rotulo} (${p})`);
                await wa(jid, "Pronto, você não vai mais receber as notificações do Moodle por aqui.");
                if (!mesmoNumero(p, ADMIN)) await wa(ADMIN, `*${rotulo}* respondeu SAIR e foi removido(a) das notificações do Moodle`);
                return true;
            }
        }

        if (!ehAdmin(...ids)) return false;

        const p = esperando();
        if (p) return responderEspera(p, { jid, texto, msg });

        // Cartao de contato sem /add-pessoa antes: nao adiciona
        if (contatosDaMensagem(msg?.message).length) {
            await enviarDigitando(jid, [
                "Recebi um contato, mas não adicionei ninguém",
                "Para a pessoa receber as notificações do Moodle, mande /add-pessoa e depois envie o contato",
            ]);
            return true;
        }
        return false;
    },

    // Bot adicionado a um grupo: avisa o admin no privado (uma vez por grupo).
    // Varios grupos de uma vez = sincronizacao inicial da conta, nao "fui adicionado": so registra.
    onGrupoNovo: async ({ grupo, lote }) => {
        const cache = getCache();
        const vistos = cache._gruposVistos || (cache._gruposVistos = []);
        if (vistos.includes(grupo.id)) return;
        vistos.push(grupo.id);
        salvarCache();
        if (lote > 2 || DESTINOS_GRUPO.includes(grupo.id)) return;
        log("info", `Adicionado ao grupo "${grupo.subject}" (${grupo.id})`);
        await wa(ADMIN, `Fui adicionado ao grupo *${grupo.subject}*.\n\nPara eu enviar as notificações do Moodle nele, mande /add-grupo`);
    },

    // Exportados para os testes
    _contatosDaMensagem: contatosDaMensagem,
    _lerComando:         lerComando,
    _numerosDaResposta:  numerosDaResposta,
};
