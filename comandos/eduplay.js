'use strict';

const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");
const { ADMIN } = require("./moodle/config");
const { wa }    = require("./moodle/notificacoes");

const CACHE_PATH   = path.join(__dirname, "../moodle/eduplay_legendas.json");
const LEGENDAS_DIR = path.join(__dirname, "../moodle/legendas");

// Cache leve: ID -> { titulo, nomeArquivo }
let cache = (() => {
    try { if (fs.existsSync(CACHE_PATH)) return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")); }
    catch {}
    return {};
})();

function salvarCache() {
    try { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf8"); }
    catch (e) { console.error("[eduplay] Erro ao salvar cache:", e.message); }
}

// HTTP GET com suporte a redirect
function httpGet(url, redirs = 0) {
    return new Promise((resolve, reject) => {
        if (redirs > 5) return reject(new Error("Muitos redirecionamentos"));
        const lib = url.startsWith("https") ? https : http;
        const req = lib.get(url, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0" },
        }, res => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                res.resume();
                return httpGet(res.headers.location, redirs + 1).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                const err = new Error(`HTTP ${res.statusCode}`);
                if ([502, 503, 504].includes(res.statusCode)) err.foraDoAr = true;
                return reject(err);
            }
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => resolve(data));
        });
        req.setTimeout(15000, () => { req.destroy(); reject(Object.assign(new Error("Timeout"), { foraDoAr: true })); });
        req.on("error", e => reject(
            ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"].includes(e.code)
                ? Object.assign(e, { foraDoAr: true }) : e
        ));
    });
}

// Converte VTT (legenda) para texto limpo
function parsearVTT(vttText) {
    const textos = [];
    for (const linha of vttText.split(/\r?\n/)) {
        const l = linha.trim();
        if (!l || l.startsWith("WEBVTT") || /^\d+$/.test(l)) continue;
        if (/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->/.test(l)) continue;
        if (/^(?:NOTE|REGION|STYLE)\b/.test(l)) continue;
        const texto = l.replace(/<[^>]+>/g, "").trim();
        if (texto) textos.push(texto);
    }
    return textos.join("\n");
}

// Extrai numero da aula do titulo (arabico ou romano)
function extrairNumeroAula(titulo) {
    const t = titulo || "";
    const mArabico = t.match(/aula\s*(\d+)/i);
    if (mArabico) return mArabico[1];
    const mRomano = t.match(/aula\s+([IVXLCDM]+)\b/i);
    if (mRomano) {
        const vals = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
        let total = 0;
        const s = mRomano[1].toUpperCase();
        for (let i = 0; i < s.length; i++) {
            const curr = vals[s[i]];
            if (!curr) return null;
            total += (vals[s[i + 1]] > curr) ? -curr : curr;
        }
        return total > 0 ? String(total) : null;
    }
    return null;
}

const REGEX_LINK = /eduplay\.rnp\.br\/app\/video\/(embed\/)?(\d+)/i;

function extrairIdELink(texto) {
    const m = texto.match(REGEX_LINK);
    return m ? { isEmbed: !!m[1], id: m[2] } : null;
}

// Baixa legenda do EduPlay e salva em disco
async function baixarEPersistir(id, isEmbed) {
    const apiPath = isEmbed ? `videos/embed/${id}` : `videos/${id}`;
    const metaRaw = await httpGet(`https://eduplay.rnp.br/api/v1/${apiPath}?startStreaming=0`);
    let meta;
    try { meta = JSON.parse(metaRaw); }
    catch { throw Object.assign(new Error("Resposta inesperada da API do EduPlay"), { foraDoAr: true }); }

    const titulo    = meta.name || meta.mediaInfo?.contentTitle || `Video ${id}`;
    const subtitles = meta.mediaInfo?.subtitles;
    if (!subtitles?.portugues?.filePath)
        throw Object.assign(new Error("Nenhuma legenda em portugues encontrada."), { semLegenda: true });

    const legendaTexto = parsearVTT(await httpGet(subtitles.portugues.filePath));
    const numAula      = extrairNumeroAula(titulo);
    const nomeBase     = numAula ? `legendas-aula${numAula}.txt` : null;
    const nomeOcupado  = nomeBase && Object.values(cache).some(e => e.nomeArquivo === nomeBase);
    const nomeArquivo  = (nomeBase && !nomeOcupado)
        ? nomeBase
        : `legendas-${numAula ? `aula${numAula}-` : ""}${id}.txt`;

    if (!fs.existsSync(LEGENDAS_DIR)) fs.mkdirSync(LEGENDAS_DIR, { recursive: true });
    const caminhoArquivo = path.join(LEGENDAS_DIR, nomeArquivo);
    fs.writeFileSync(caminhoArquivo, legendaTexto, "utf8");

    cache[id] = { titulo, nomeArquivo, dataCache: new Date().toISOString() };
    salvarCache();
    return { titulo, nomeArquivo, caminhoArquivo };
}

function match(textoLower) { return REGEX_LINK.test(textoLower); }

async function executar({ botWhatsApp, jid, texto }) {
    const info = extrairIdELink(texto);
    if (!info) return;
    const { id, isEmbed } = info;

    // Cache hit: verifica se o arquivo ainda existe
    if (cache[id]) {
        const { titulo, nomeArquivo } = cache[id];
        const caminhoArquivo = path.join(LEGENDAS_DIR, nomeArquivo);
        if (fs.existsSync(caminhoArquivo)) {
            await botWhatsApp.sendMessage(jid, { text: titulo, linkPreview: false });
            await botWhatsApp.sendMessage(jid, { document: fs.readFileSync(caminhoArquivo), mimetype: "text/plain", fileName: nomeArquivo });
            return;
        }
        delete cache[id];
        salvarCache();
    }

    try {
        const { titulo, nomeArquivo, caminhoArquivo } = await baixarEPersistir(id, isEmbed);
        await botWhatsApp.sendMessage(jid, { text: titulo, linkPreview: false });
        await botWhatsApp.sendMessage(jid, { document: fs.readFileSync(caminhoArquivo), mimetype: "text/plain", fileName: nomeArquivo });
    } catch (e) {
        console.error("[eduplay]", e);
        if (e.semLegenda || (!e.foraDoAr)) {
            await botWhatsApp.sendMessage(jid, { text: "Infelizmente nao consegui a legenda dessa aula.", linkPreview: false });
            if (!e.semLegenda) await wa(ADMIN, `*EduPlay — erro inesperado*\nVideo: \`${id}\`\n\`${e.message}\``);
        } else {
            await botWhatsApp.sendMessage(jid, { text: "O EduPlay parece estar fora do ar. Tente novamente mais tarde.", linkPreview: false });
        }
    }
}

module.exports = { nome: "eduplay", match, executar };
