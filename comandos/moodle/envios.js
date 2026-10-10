'use strict';

const { ADMIN, DESTINOS_GRUPO, DESTINOS_PESSOAL } = require("./config");
const { sleep, log }                               = require("./utils");
const { baixarArquivoComRetry }                    = require("./http");
const { wa, broadcastArquivo }                     = require("./notificacoes");
const { limparHTML, fmtData, normalizarNomeDisciplina, todosAnexos, linkAtiv } = require("./formatacao");

// Todos os destinos configurados (grupos + pessoais)
const TODOS = () => [...DESTINOS_GRUPO, ...DESTINOS_PESSOAL];

// Envia notificacao completa de atividade (texto + link + descricao + anexos)
async function enviarAtividade(destinos, nomeCurso, a, titulo = "*UMA NOVA ATIVIDADE FOI LANCADA NO MOODLE*") {
    const cabecalho =
        `${titulo}\n\n` +
        `- Disciplina: ${normalizarNomeDisciplina(nomeCurso)}\n\n` +
        `- ${a.name}\n\n\n` +
        `- Vencimento: ${fmtData(a.duedate)}`;

    for (const jid of destinos) { await wa(jid, cabecalho); await sleep(400); }
    for (const jid of destinos) { await wa(jid, `Link: ${linkAtiv(a.cmid)}`); await sleep(400); }
    await enviarDetalhes(destinos, a);
}

// Envia varias atividades novas numa unica mensagem-resumo; descricao e anexos seguem por atividade
async function enviarAtividadesAgrupadas(destinos, lista) {
    const itens = lista.map(({ nomeCurso, a }) =>
        `- ${normalizarNomeDisciplina(nomeCurso)}: ${a.name}\n  Vencimento: ${fmtData(a.duedate)}\n  Link: ${linkAtiv(a.cmid)}`
    ).join("\n\n");
    const msg = `*${lista.length} NOVAS ATIVIDADES FORAM LANCADAS NO MOODLE*\n\n${itens}`;
    for (const jid of destinos) { await wa(jid, msg); await sleep(400); }
    for (const { a } of lista) await enviarDetalhes(destinos, a, `${a.name}\n\n`);
}

// Descricao e anexos de uma atividade (prefixo identifica a atividade quando ha varias)
async function enviarDetalhes(destinos, a, prefixo = "") {
    const desc = limparHTML(a.intro);
    if (desc)
        for (const jid of destinos) { await wa(jid, `${prefixo}Descricao:\n\n\`\`\`\n${desc}\n\`\`\``); await sleep(400); }

    const anexos = todosAnexos(a);
    if (!anexos.length) return;

    for (const jid of destinos) { await wa(jid, `${prefixo}${anexos.length === 1 ? "Arquivo:" : "Arquivos:"}`); await sleep(300); }

    for (const arq of anexos) {
        try {
            const { buffer, mimetype } = await baixarArquivoComRetry(arq.fileurl);
            await broadcastArquivo(buffer, mimetype, arq.filename, destinos);
        } catch (e) {
            log("erro", `Falha ao baixar ${arq.filename}: ${e.message}`);
            await wa(ADMIN, `*Moodle Monitor*\nFalha ao baixar anexo: ${arq.filename}\n${e.message}`);
        }
    }
}

// Envia apenas os anexos novos de uma atividade atualizada
async function enviarAnexosAtualizados(novosArqs, destinos = TODOS()) {
    for (const arq of novosArqs) {
        try {
            const { buffer, mimetype } = await baixarArquivoComRetry(arq.fileurl);
            await broadcastArquivo(buffer, mimetype, arq.filename, destinos);
        } catch (e) {
            log("erro", `Falha ao baixar ${arq.filename}: ${e.message}`);
            await wa(ADMIN, `*Moodle Monitor*\nFalha ao baixar anexo atualizado: ${arq.filename}\n${e.message}`);
        }
    }
}

module.exports = { enviarAtividade, enviarAtividadesAgrupadas,enviarAnexosAtualizados, TODOS };
