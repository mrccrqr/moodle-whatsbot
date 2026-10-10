'use strict';

const { DateTime } = require("luxon");
const { HOST, ZONA, NOMES_CURTOS, LINKS_FIXOS } = require("./config");

// Remove tags HTML e converte entidades para texto limpo
function limparHTML(html) {
    if (!html) return "";
    return html
        .replace(/\r\n/g, "\n").replace(/\r/g, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<\/[uo]l>/gi, "\n")
        .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => {
            const c = inner.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
            return c ? `- ${c}\n` : "";
        })
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'")
        .replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n")
        .replace(/\n{2,}/g, "\n")
        .trim();
}

// Formata timestamp unix para data legivel ("dd/MM as HH:mm")
function fmtData(duedate) {
    if (!duedate) return "Sem prazo definido";
    const dt = DateTime.fromSeconds(duedate).setZone(ZONA);
    const [h, d] = [dt.toFormat("HH:mm"), dt.toFormat("dd/MM")];
    if (h === "00:00") return `${d} a meia-noite`;
    if (h === "23:59") return `${d} as 23h59`;
    return `${d} as ${h}`;
}

// Formata timestamp unix para so o horario ("HH:mm")
function fmtHorario(ts) {
    return DateTime.fromSeconds(ts).setZone(ZONA).toFormat("HH:mm");
}

// Aplica nomes curtos configurados em disciplinas.json
function normalizarNomeDisciplina(fullname) {
    let nome = fullname.replace(/\s*\(?\d{4}\.\d\)?\s*$/, "").trim();
    for (const [chave, curto] of Object.entries(NOMES_CURTOS))
        if (nome.includes(chave)) return curto;
    return nome;
}

// Retorna link fixo da disciplina se configurado
function linkFixo(disciplinaNormalizada) {
    for (const [chave, link] of Object.entries(LINKS_FIXOS))
        if (disciplinaNormalizada.toLowerCase().includes(chave.toLowerCase())) return link;
    return null;
}

// Extrai primeiro href de uma descricao HTML
function extrairLinkSala(descricaoHtml) {
    if (!descricaoHtml) return null;
    const match = descricaoHtml.match(/href="([^"]+)"/);
    return match ? match[1] : null;
}

// Junta anexos da atividade sem duplicatas
const todosAnexos = a => [...(a.introattachments || []), ...(a.introfiles || [])]
    .filter((f, i, arr) => arr.findIndex(x => x.filename === f.filename) === i);

// Link direto para a atividade no Moodle
const linkAtiv = cmid => `https://${HOST}/mod/assign/view.php?id=${cmid}`;

module.exports = {
    limparHTML, fmtData, fmtHorario,
    normalizarNomeDisciplina, linkFixo, extrairLinkSala,
    todosAnexos, linkAtiv,
};
