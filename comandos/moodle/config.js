'use strict';

const fs   = require("fs");
const path = require("path");
const { paraJid, mesmoNumero, ehGrupo, ehLid } = require("../../utils/telefone");

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
// Por onde as chamadas ao Moodle saem. Normalmente o proprio Moodle; quando o Moodle bloqueia o servidor do bot
// (ex.: acesso de fora do Brasil), aponte para um repasse no Brasil (ex.: API Gateway da AWS em sa-east-1).
// Os links enviados aos alunos continuam usando MOODLE_HOST.
const API_HOST = (process.env.MOODLE_API_HOST || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "") || HOST;
obrigatorio("MOODLE_USER");
obrigatorio("MOODLE_PASS");

// Numero do admin: basta DDD + numero (ex.: 77991234567). ADMIN_JID e o nome antigo, ainda aceito.
const _admin = process.env.ADMIN_NUMERO || process.env.ADMIN_JID;
if (!_admin)
    throw new Error("Variavel obrigatoria nao definida: ADMIN_NUMERO (seu numero com DDD, ex.: 77991234567). Verifique o arquivo moodle/.env");
const ADMIN = paraJid(_admin);

// --- Variaveis opcionais ---
const ZONA          = "America/Sao_Paulo";
const ADMIN_LID     = process.env.ADMIN_LID || null;
const PARENT_CAT_ID = parseInt(process.env.MOODLE_PARENT_CAT_ID || "0", 10);

// Telegram: fallback opcional — se WhatsApp falhar, tenta enviar por la
const TG_TOKEN   = process.env.TG_TOKEN || null;
const TG_CHAT_ID = process.env.TG_CHAT_ID || null;

// Destinos de notificacao: grupos (ativados com /ativar, ver comandos/grupos.js) e/ou numeros (DDD + numero).
// Os arrays sao alterados em tempo de execucao quando um grupo e ativado/desativado.
const _DESTINOS        = (process.env.DESTINOS || "").split(",").map(s => paraJid(s)).filter(Boolean);
const DESTINOS_GRUPO   = _DESTINOS.filter(ehGrupo);
const DESTINOS_PESSOAL = _DESTINOS.filter(s => !ehGrupo(s));

// O admin pode chegar como numero (com ou sem o nono digito) ou como LID (@lid, ID de privacidade
// do WhatsApp, comum em grupos). Quando uma mensagem traz os dois, o LID e aprendido.
const lidsAdmin = new Set(ADMIN_LID ? [ADMIN_LID] : []);
function ehAdmin(...ids) {
    ids = ids.filter(Boolean);
    const admin = ids.some(id => lidsAdmin.has(id) || mesmoNumero(id, ADMIN));
    if (admin) ids.filter(ehLid).forEach(l => lidsAdmin.add(l));
    return admin;
}

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

// Token do Moodle — gerenciado automaticamente (login gera, .env persiste).
// So vale se foi gerado para o MOODLE_USER atual: trocar de conta no .env descarta o token antigo.
const tokenDoUsuarioAtual = process.env.MOODLE_TOKEN && process.env.MOODLE_TOKEN_USER === process.env.MOODLE_USER;
const estado = {
    wsToken:   tokenDoUsuarioAtual ? process.env.MOODLE_TOKEN : null,
    accessKey: null,
    userId:    null,
};

// Grava (ou substitui) uma variavel no moodle/.env, preservando o resto do arquivo
function definirNoEnv(chave, valor) {
    let conteudo = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
    const re = new RegExp(`^${chave}=.*`, "m");
    conteudo = re.test(conteudo) ? conteudo.replace(re, `${chave}=${valor}`) : `${chave}=${valor}\n` + conteudo;
    fs.writeFileSync(ENV_PATH, conteudo, "utf8");
    process.env[chave] = String(valor);
}

// Persiste os destinos atuais (grupos + numeros) na linha DESTINOS do .env
function salvarDestinos() {
    definirNoEnv("DESTINOS", [...DESTINOS_GRUPO, ...DESTINOS_PESSOAL].join(","));
}

module.exports = {
    ENV_PATH, CACHE_PATH, LOG_PATH, DISCIPLINAS_PATH, DADOS_DIR,
    ZONA, HOST, API_HOST, ADMIN, ADMIN_LID, PARENT_CAT_ID,
    TG_TOKEN, TG_CHAT_ID,
    DESTINOS_GRUPO, DESTINOS_PESSOAL, ehAdmin, definirNoEnv, salvarDestinos,
    NOMES_CURTOS, LINKS_FIXOS, DISCIPLINAS_IGNORADAS, AULAS_EXTRAS,
    estado,
};
