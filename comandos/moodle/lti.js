'use strict';

const https       = require("https");
const querystring = require("querystring");
const { log }     = require("./utils");
const { moodle }  = require("./api");

// Cache de resolucao LTI: cmid -> { roomHash, publicUrl, ts }
const cache    = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000;

// Mapa cmid -> lti id (recarregado a cada 24h)
let ltiMap = null, ltiMapTs = 0;
const LTI_MAP_TTL = 24 * 60 * 60 * 1000;

async function carregarLtiMap() {
    if (ltiMap && Date.now() - ltiMapTs < LTI_MAP_TTL) return ltiMap;
    const d = await moodle({ wsfunction: "mod_lti_get_ltis_by_courses" });
    if (!d.ltis) throw new Error("mod_lti_get_ltis_by_courses: resposta invalida");
    ltiMap = new Map();
    for (const lti of d.ltis) ltiMap.set(lti.coursemodule, lti.id);
    ltiMapTs = Date.now();
    log("info", `[lti] mapa carregado: ${ltiMap.size} LTI(s)`);
    return ltiMap;
}

// HTTP request generico com suporte a cookies
function httpsReq(method, urlStr, body, cookies) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const opts = {
            hostname: url.hostname, path: url.pathname + url.search,
            method, timeout: 15000,
            headers: {
                "User-Agent": "Mozilla/5.0",
                ...(body ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } : {}),
                ...(cookies ? { "Cookie": cookies } : {}),
            }
        };
        const req = https.request(opts, res => {
            const setCookies = res.headers["set-cookie"] || [];
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => resolve({
                status: res.statusCode, headers: res.headers,
                body: data, cookies: mergeCookies(cookies, setCookies),
            }));
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

function mergeCookies(existing, setCookies) {
    const map = {};
    if (existing)
        for (const part of existing.split(";")) {
            const [k, ...v] = part.trim().split("=");
            if (k) map[k.trim()] = v.join("=");
        }
    for (const sc of (setCookies || [])) {
        const [kv] = sc.split(";");
        const [k, ...v] = kv.split("=");
        if (k) map[k.trim()] = v.join("=");
    }
    return Object.entries(map).map(([k, v]) => `${k}=${v}`).join("; ");
}

// Segue cadeia de redirects e auto-submits (paginas intermediarias do Mconf)
async function seguirCadeia(resp, maxSteps = 15) {
    for (let i = 0; i < maxSteps; i++) {
        if ([301, 302, 303].includes(resp.status)) {
            let loc = resp.headers.location;
            if (!loc.startsWith("http")) {
                const base = new URL(resp._url || "https://lti.mconf.rnp.br");
                loc = `https://${base.hostname}${loc}`;
            }
            resp = await httpsReq("GET", loc, null, resp.cookies);
            resp._url = loc;
            continue;
        }
        const actionMatch = resp.body.match(/action=["']([^"']+)["']/);
        const tokenMatch  = resp.body.match(/name=["']authenticity_token["']\s+value=["']([^"']+)["']/);
        if (actionMatch && tokenMatch && /repost-|\.submit\(\)/.test(resp.body)) {
            let url = actionMatch[1];
            if (!url.startsWith("http")) url = `https://lti.mconf.rnp.br${url}`;
            resp = await httpsReq("POST", url, querystring.stringify({ authenticity_token: tokenMatch[1] }), resp.cookies);
            resp._url = url;
            continue;
        }
        break;
    }
    return resp;
}

// Resolve link LTI do Moodle para URL publica do Mconf
async function resolverLinkLTI(cmid) {
    const cached = cache.get(cmid);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached;

    const map    = await carregarLtiMap();
    const toolId = map.get(cmid);
    if (!toolId) { log("aviso", `[lti] cmid=${cmid} nao encontrado`); return null; }

    const launchData = await moodle({ wsfunction: "mod_lti_get_tool_launch_data", toolid: toolId });
    if (!launchData.endpoint || !launchData.parameters) {
        log("aviso", `[lti] sem launch data para toolid=${toolId}`);
        return null;
    }

    const params = Object.fromEntries(launchData.parameters.map(p => [p.name, p.value]));
    let resp = await httpsReq("POST", launchData.endpoint, querystring.stringify(params), null);
    resp._url = launchData.endpoint;
    const page = await seguirCadeia(resp);

    const roomMatch = page.body.match(/\/rooms\/([a-f0-9]{40})/);
    if (!roomMatch) { log("aviso", `[lti] sem room hash para cmid=${cmid}`); return null; }
    const roomHash = roomMatch[1];

    // A sala pode ter varios grupos do Moodle (ex.: "Aula Virtual", "Brumado", "Jacaraci"): o aluno participa
    // de todos, mas a aula e agendada em so um deles (nos testes, sempre o "Aula Virtual", nunca o do polo).
    // Por isso nao se escolhe pelo nome do polo: procura-se o grupo que TEM reuniao agendada.
    let meetingId = extrairReuniao(page.body);
    let grupoUsado = null;

    const grupos = [...page.body.matchAll(/<option[^>]*value="(\d+)"[^>]*>([^<]+)<\/option>/g)]
        .map(m => ({ id: m[1], nome: m[2].trim() }));
    const csrf = page.body.match(/name="authenticity_token" value="([^"]+)"/)?.[1];

    if (!meetingId && grupos.length > 1 && csrf) {
        // Ordem de tentativa: o grupo que funcionou da ultima vez, depois "aula/sala virtual", depois o resto
        const preferido = grupoPorSala.get(roomHash);
        const ordem = [...grupos].sort((a, b) => peso(b, preferido) - peso(a, preferido));
        for (const g of ordem) {
            const pagina = await trocarGrupo(roomHash, csrf, g.id, page.cookies);
            meetingId = extrairReuniao(pagina.body);
            if (meetingId) { grupoUsado = g.nome; grupoPorSala.set(roomHash, g.nome); break; }
        }
    }

    // Link da sessao agendada (so /external funciona sem login)
    const publicUrl = meetingId
        ? `https://lti.mconf.rnp.br/rooms/${roomHash}/scheduled_meetings/${meetingId}/external`
        : null;

    const result = { roomHash, publicUrl, ts: Date.now() };
    cache.set(cmid, result);
    log("ok", `[lti] cmid=${cmid}: room=${roomHash}` +
        (publicUrl ? ` meeting=${meetingId}${grupoUsado ? ` (grupo "${grupoUsado}")` : ""}` : " (sem sessao)"));
    return result;
}

// Grupo que tinha reuniao na ultima consulta de cada sala (evita testar todos de novo)
const grupoPorSala = new Map();

const peso = (g, preferido) => (g.nome === preferido ? 2 : 0) + (/aula virtual|sala virtual|virtual/i.test(g.nome) ? 1 : 0);

const extrairReuniao = html => html.match(/\/rooms\/[a-f0-9]+\/scheduled_meetings\/([A-Za-z0-9_-]+)\/join/)?.[1] || null;

// Seleciona um grupo na sala Mconf e devolve a pagina resultante
async function trocarGrupo(roomHash, csrf, groupId, cookies) {
    const url  = `https://lti.mconf.rnp.br/rooms/${roomHash}/set_current_group_on_session?redir_url=%2Frooms%2F${roomHash}`;
    const resp = await httpsReq("POST", url, querystring.stringify({ utf8: "✓", authenticity_token: csrf, group_id: groupId }), cookies);
    if (![302, 303].includes(resp.status)) return resp;
    let loc = resp.headers.location;
    if (!loc.startsWith("http")) loc = `https://lti.mconf.rnp.br${loc}`;
    return httpsReq("GET", loc, null, resp.cookies);
}

// Extrai cmid de uma descricao HTML e resolve o melhor link disponivel
async function obterLinkDinamico(descricaoHtml) {
    const cmidMatch = (descricaoHtml || "").match(/\/mod\/lti\/view\.php\?id=(\d+)/);
    if (!cmidMatch) return null;
    try {
        const r = await resolverLinkLTI(parseInt(cmidMatch[1], 10));
        return r?.publicUrl || null;
    } catch (e) {
        log("aviso", `[lti] falha ao resolver cmid=${cmidMatch[1]}: ${e.message}`);
        return null;
    }
}

module.exports = { obterLinkDinamico, resolverLinkLTI, carregarLtiMap };
