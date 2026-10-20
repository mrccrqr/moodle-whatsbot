'use strict';

const { ADMIN, DESTINOS_GRUPO, DESTINOS_PESSOAL } = require("./config");
const { sleep, log }                               = require("./utils");
const { baixarArquivoComRetry }                    = require("./http");
const { wa, broadcastArquivo }                     = require("./notificacoes");
const { limparHTML, fmtData, normalizarNomeDisciplina, todosAnexos, linkAtiv } = require("./formatacao");

// Todos os destinos configurados (grupos + pessoais). Sem DESTINOS, vai so para o admin.
const TODOS = () => {
    const d = [...DESTINOS_GRUPO, ...DESTINOS_PESSOAL];
    return d.length ? d : [ADMIN];
};

// Textos acima disso viram arquivo .txt (no WhatsApp, mensagem longa vira "Ler mais" e polui a conversa)
const LIMITE_TEXTO = 1000;

// Envia um texto longo (descricao, aviso, feedback) direto ou, se passar do limite, como arquivo .txt
async function enviarTextoOuArquivo(destinos, rotulo, texto, nomeArquivo = "descrição.txt") {
    if (!texto) return;
    if (texto.length <= LIMITE_TEXTO) {
        for (const jid of destinos) { await wa(jid, `${rotulo}:\n\n\`\`\`\n${texto}\n\`\`\``); await sleep(400); }
        return;
    }
    const buffer = Buffer.from(texto, "utf8");
    await broadcastArquivo(buffer, "text/plain", nomeArquivo, destinos, `${rotulo} (texto longo, segue em arquivo)`);
}

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
    await enviarTextoOuArquivo(destinos, `${prefixo}Descricao`, limparHTML(a.intro));

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

module.exports = { enviarAtividade, enviarAtividadesAgrupadas, enviarDetalhes, enviarAnexosAtualizados, enviarTextoOuArquivo, LIMITE_TEXTO, TODOS };
