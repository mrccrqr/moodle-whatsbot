'use strict';

const fs             = require("fs");
const path           = require("path");
const { CACHE_PATH } = require("./config");
const { log, agora } = require("./utils");

// Cache de atividades ja notificadas (persiste em disco)
let cache = (() => {
    try {
        if (fs.existsSync(CACHE_PATH)) return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    } catch (e) { log("erro", "Cache corrompido, reiniciando:", e.message); }
    return {};
})();

function salvarCache() {
    try {
        const dir = path.dirname(CACHE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) { log("erro", "Falha ao salvar cache:", e.message); }
}

// Remove entradas antigas (avisos de vencimento de 30+ dias, aulas/foruns de dias passados).
// Registros de tarefas/modulos/notas NAO sao removidos: sao eles que dizem ao bot o que ja existia
// (apagar um deles faria a atividade ser avisada de novo como "nova").
function purgarCache() {
    const hoje         = agora().toISODate();
    const limiteVenc   = agora().minus({ days: 30 }).toUnixInteger();
    let n = 0;
    for (const k of Object.keys(cache)) {
        if ((k.startsWith("venc_") && cache[k]?.duedate < limiteVenc) || (k.startsWith("lemb_") && cache[k]?.prazo < limiteVenc)) { delete cache[k]; n++; continue; }
        const m = k.match(/^(?:aula_\d+|forum_\d+|extra_.+)_(\d{4}-\d{2}-\d{2})$/);
        if (m && m[1] < hoje) { delete cache[k]; n++; }
    }
    if (n > 0) { log("info", `Cache: ${n} entrada(s) antiga(s) removida(s).`); salvarCache(); }
}

function getCache() { return cache; }

module.exports = { getCache, salvarCache, purgarCache };
