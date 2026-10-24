'use strict';

// Como o bot chega ao Moodle. Configurado no moodle/.env (ver docs/REPASSE.md):
//
//   MOODLE_ACESSO=direto    (padrao) conecta direto em MOODLE_HOST
//   MOODLE_ACESSO=repasse   as chamadas saem por MOODLE_REPASSE_URL (ex.: API Gateway da AWS no Brasil)
//   MOODLE_ACESSO=proxy     as chamadas saem pelo proxy SOCKS em MOODLE_PROXY (socks5://host:porta)
//
// Para desligar o repasse/proxy sem apagar a configuracao: MOODLE_ACESSO=direto.
// Os links enviados aos alunos sempre usam MOODLE_HOST.
// Compatibilidade: .env sem MOODLE_ACESSO e com MOODLE_API_HOST (nome antigo) -> repasse.

const MODOS = ["direto", "repasse", "proxy"];

// "https://abc.execute-api.sa-east-1.amazonaws.com/" -> "abc.execute-api.sa-east-1.amazonaws.com"
const limparHost = s => (s || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

function configAcesso(env = process.env) {
    const host    = limparHost(env.MOODLE_HOST) || "moodle4.uesb.br";
    const repasse = limparHost(env.MOODLE_REPASSE_URL || env.MOODLE_API_HOST);
    const proxy   = (env.MOODLE_PROXY || "").trim();
    let modo = (env.MOODLE_ACESSO || "").trim().toLowerCase();
    if (!modo) modo = repasse ? "repasse" : proxy ? "proxy" : "direto";

    if (!MODOS.includes(modo))
        throw new Error(`MOODLE_ACESSO invalido: "${modo}" (use direto, repasse ou proxy). Verifique o arquivo moodle/.env`);
    if (modo === "repasse" && !repasse)
        throw new Error("MOODLE_ACESSO=repasse, mas MOODLE_REPASSE_URL esta vazio. Crie um com: npm run repasse -- criar");
    if (modo === "proxy" && !proxy)
        throw new Error("MOODLE_ACESSO=proxy, mas MOODLE_PROXY esta vazio (ex.: socks5://127.0.0.1:1080)");

    return {
        modo,
        host,                                              // usado nos links para os alunos
        apiHost: modo === "repasse" ? repasse : host,      // por onde as chamadas saem
        agente:  modo === "proxy" ? new (require("socks-proxy-agent").SocksProxyAgent)(proxy) : undefined,
        descricao: modo === "direto"  ? `direto (${host})`
                 : modo === "repasse" ? `pelo repasse ${repasse}`
                 :                      `pelo proxy ${proxy.replace(/\/\/.*@/, "//***@")}`,
    };
}

module.exports = { configAcesso, limparHost, MODOS };
