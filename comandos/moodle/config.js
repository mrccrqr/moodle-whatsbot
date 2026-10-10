'use strict';

const fs   = require("fs");
const path = require("path");

// Caminhos do projeto
const DADOS_DIR        = path.join(__dirname, "../../moodle");
const ENV_PATH         = path.join(DADOS_DIR, ".env");
const CACHE_PATH       = path.join(DADOS_DIR, "cache.json");
const LOG_PATH         = path.join(DADOS_DIR, "logs.txt");
const DISCIPLINAS_PATH = path.join(__dirname, "disciplinas.json");

// Garante que a pasta de dados existe
if (!fs.existsSync(DADOS_DIR)) fs.mkdirSync(DADOS_DIR, { recursive: true });

// Carrega variaveis do moodle/.env (separado do .env raiz)
require("dotenv").config({ path: ENV_PATH, quiet: true });

// Valida variavel obrigatoria, retorna valor ou padrao
function obrigatorio(chave, padrao) {
    const valor = process.env[chave];
    if (!valor && padrao === undefined)
        throw new Error(`Variavel obrigatoria nao definida: ${chave}. Verifique o arquivo moodle/.env`);
    return valor || padrao;
}

// --- Variaveis obrigatorias ---
const HOST  = obrigatorio("MOODLE_HOST", "moodle4.uesb.br");
const ADMIN = obrigatorio("ADMIN_JID");
obrigatorio("MOODLE_USER");
obrigatorio("MOODLE_PASS");

// --- Variaveis opcionais ---
const ZONA          = "America/Sao_Paulo";
const ADMIN_LID     = process.env.ADMIN_LID || null;
const PARENT_CAT_ID = parseInt(process.env.MOODLE_PARENT_CAT_ID || "0", 10);

// Telegram: fallback opcional — se WhatsApp falhar, tenta enviar por la
const TG_TOKEN   = process.env.TG_TOKEN || null;
const TG_CHAT_ID = process.env.TG_CHAT_ID || null;

// Destinos de notificacao (grupos e/ou contatos pessoais)
const _DESTINOS    = (process.env.DESTINOS || "").split(",").map(s => s.trim()).filter(Boolean);
const DESTINOS_GRUPO   = _DESTINOS.filter(s => s.endsWith("@g.us"));
const DESTINOS_PESSOAL = _DESTINOS.filter(s => s.endsWith("@s.whatsapp.net"));

// Mapeamento de disciplinas (nomes curtos, links fixos, etc.)
function carregarDisciplinas() {
    try { return JSON.parse(fs.readFileSync(DISCIPLINAS_PATH, "utf8")); }
    catch { return {}; }
}

const _disc                 = carregarDisciplinas();
const NOMES_CURTOS          = _disc.nomesCurtos || {};
const LINKS_FIXOS           = _disc.linksFixos || {};
const DISCIPLINAS_IGNORADAS = new Set((_disc.disciplinasIgnoradas || []).map(s => s.toLowerCase()));
const AULAS_EXTRAS          = _disc.aulasExtras || [];

// Token do Moodle — gerenciado automaticamente (login gera, .env persiste)
const estado = {
    wsToken:   process.env.MOODLE_TOKEN || null,
    accessKey: null,
    userId:    null,
};

module.exports = {
    ENV_PATH, CACHE_PATH, LOG_PATH, DISCIPLINAS_PATH, DADOS_DIR,
    ZONA, HOST, ADMIN, ADMIN_LID, PARENT_CAT_ID,
    TG_TOKEN, TG_CHAT_ID,
    DESTINOS_GRUPO, DESTINOS_PESSOAL,
    NOMES_CURTOS, LINKS_FIXOS, DISCIPLINAS_IGNORADAS, AULAS_EXTRAS,
    estado,
};
