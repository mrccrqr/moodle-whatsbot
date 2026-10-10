'use strict';

const { ehAdmin }                  = require("./moodle/config");
const { buscarCursos }             = require("./moodle/api");
const { normalizarNomeDisciplina } = require("./moodle/formatacao");

module.exports = {
    nome:  "/disciplinas",
    match: texto => texto === "/disciplinas",

    executar: async ({ botWhatsApp, jid, jidUsuario, msg }) => {
        if (!ehAdmin(jid, jidUsuario, msg?.key?.remoteJidAlt, msg?.key?.participantAlt)) return;

        let cursos;
        try { cursos = await buscarCursos(); }
        catch (e) {
            return botWhatsApp.sendMessage(jid, { text: `Erro ao buscar disciplinas:\n${e.message}`, linkPreview: false });
        }

        if (!cursos.length)
            return botWhatsApp.sendMessage(jid, { text: "Nenhuma disciplina encontrada para o semestre atual.", linkPreview: false });

        const grupos = new Map();
        for (const c of cursos) {
            const cat = c.categoryname || "Sem categoria";
            if (!grupos.has(cat)) grupos.set(cat, []);
            grupos.get(cat).push(normalizarNomeDisciplina(c.fullname));
        }

        let texto;
        if (grupos.size === 1) {
            const lista = [...grupos.values()][0].map(n => `- ${n}`).join("\n");
            texto = `*DISCIPLINAS DO SEMESTRE ATUAL*\n\n${lista}\n\n_${cursos.length} disciplina(s)_`;
        } else {
            const secoes = [...grupos.entries()]
                .map(([cat, nomes]) => `*${cat.toUpperCase()}*\n${nomes.map(n => `- ${n}`).join("\n")}`)
                .join("\n\n");
            texto = `*DISCIPLINAS DO SEMESTRE ATUAL*\n\n${secoes}\n\n_${cursos.length} disciplina(s)_`;
        }

        await botWhatsApp.sendMessage(jid, { text: texto, linkPreview: false });
    },
};
