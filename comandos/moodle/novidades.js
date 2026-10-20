'use strict';

// Novidades nas disciplinas — UMA mensagem por disciplina com tudo o que mudou:
//   - atividades novas (tarefas, questionarios, foruns, licoes...)
//   - prazos alterados (reabertos, estendidos, antecipados)
//   - materiais novos (arquivos, links, paginas, pastas)
//   - arquivos novos anexados a atividades ja avisadas
// Descricoes e anexos das atividades novas seguem logo depois da mensagem.
//
// Regras para nao mandar coisa pela metade:
//   - Professor mexendo agora: se a disciplina teve alteracao nos ultimos 30 min, ela fica para a proxima
//     verificacao (no maximo 6h de espera). Assim, uma semana montada aos poucos sai numa mensagem so.
//   - Rascunhos: nome com "(copiado)", "(copia)", "(copy)" -> espera o professor renomear.
//   - Item "novo" com prazo ja vencido: quase sempre copia ou atividade antiga reaproveitada -> so registra.
//   - Atividade antiga reaproveitada (encerrada ha mais de 30 dias, ou renomeada, e com prazo novo no futuro)
//     -> anunciada como atividade NOVA, nao como "prazo estendido".
//   - Prazo que ja tinha encerrado e voltou para o futuro -> "prazo reaberto".
//
// Detecao por ID (nao por data): a primeira vez que o bot ve uma disciplina, registra tudo em silencio.

const { DateTime }                         = require("luxon");
const { ZONA }                             = require("./config");
const { log }                              = require("./utils");
const { getCache, salvarCache, purgarCache } = require("./cache");
const { broadcast }                        = require("./notificacoes");
const { retry }                            = require("./auth");
const { buscarAtividades, buscarModulos, buscarAlteracoesDesde } = require("./api");
const { fmtData, normalizarNomeDisciplina, todosAnexos, linkAtiv } = require("./formatacao");
const { enviarDetalhes, enviarAnexosAtualizados, TODOS } = require("./envios");
const { comGuard, cursosDoSemestre, prazosDoModulo, agoraS } = require("./comum");

const QUIETO_S          = 30 * 60;        // disciplina sem alteracoes ha 30 min = professor terminou
const ADIAMENTO_MAX_S   = 6 * 3600;       // mesmo com o professor mexendo, nao segura mais que isso
const REAPROVEITADA_S   = 30 * 86400;     // prazo encerrado ha mais de 30 dias e reaberto = atividade nova
const RASCUNHO          = /\((copiad[oa]|c[oó]pia|copy)\)/i;
const EDICAO            = new Set(["configuration", "contentfiles", "introfiles", "files"]); // ignora notas etc.

const MATERIAIS = new Set(["resource", "url", "page", "folder", "book", "imscp"]);
const IGNORADOS = new Set(["label", "assign"]); // tarefas vem de mod_assign (com descricao e anexos)

const ROTULO_TIPO = {
    resource: "arquivo", page: "página", folder: "pasta", book: "livro", imscp: "conteúdo",
    quiz: "questionário", forum: "fórum", lesson: "lição", workshop: "workshop", choice: "enquete",
    feedback: "pesquisa", survey: "pesquisa", h5pactivity: "atividade H5P", hvp: "atividade H5P",
    scorm: "pacote SCORM", lti: "ferramenta externa", glossary: "glossário", wiki: "wiki",
    data: "banco de dados", bigbluebuttonbn: "sala virtual",
};

function rotuloTipo(m) {
    if (m.modname === "url") return /youtu\.?be|eduplay|vimeo/i.test(m.contents?.[0]?.fileurl || "") ? "vídeo" : "link";
    return ROTULO_TIPO[m.modname] || m.modname;
}

// ------------------------------------------------------------------ regras (funcoes puras)

// Como um prazo mudou: "reaberto" | "estendido" | "antecipado" | "definido" | null (nada a avisar)
function classificarPrazo(antes, depois, agoraTs) {
    if (!depois || depois <= agoraTs || antes === depois) return null; // sem prazo, ja vencido ou igual
    if (!antes)          return "definido";
    if (antes <= agoraTs) return "reaberto";
    return depois > antes ? "estendido" : "antecipado";
}

const registroTarefa = (a, antes, agoraTs) => ({
    visto:        antes?.visto ?? agoraTs,
    nome:         a.name,
    timemodified: a.timemodified,
    duedate:      a.duedate || null,
    anexos:       todosAnexos(a).map(f => f.filename),
});

const registroModulo = (m, antes, agoraTs) => ({
    visto: antes?.visto ?? agoraTs, nome: m.name, tipo: m.modname, datas: prazosDoModulo(m),
});

// Decide o que anunciar numa disciplina. Nao faz I/O: so le o cache e devolve o que mudou.
//   anunciar: itens para a mensagem;  registrar: [chave, valor] a gravar quando a mensagem sair;
//   silencio: [chave, valor] a gravar ja (nao geram aviso);  tarefasNovas / anexosNovos: para os envios extras
function detectar({ tarefas, modulos, cache, agoraTs }) {
    const r = { atividades: [], prazos: [], materiais: [], arquivos: [], registrar: [], silencio: [], tarefasNovas: [], anexosNovos: [] };

    for (const a of tarefas) {
        const chave = `assign_${a.id}`;
        const antes = cache[chave];
        const link  = linkAtiv(a.cmid);
        const prazo = a.duedate || null;
        if (RASCUNHO.test(a.name)) continue; // professor ainda editando

        if (!antes) {
            if (prazo && prazo <= agoraTs) { r.silencio.push([chave, registroTarefa(a, null, agoraTs)]); continue; }
            r.atividades.push({ nome: a.name, tipo: "tarefa", prazo, link });
            r.tarefasNovas.push(a);
            r.registrar.push([chave, registroTarefa(a, null, agoraTs)]);
            continue;
        }

        const tipo        = prazo !== antes.duedate ? classificarPrazo(antes.duedate, prazo, agoraTs) : null;
        const renomeada   = !!antes.nome && antes.nome !== a.name;
        const reaproveita = tipo === "reaberto" && (renomeada || agoraTs - antes.duedate > REAPROVEITADA_S);
        const velhos      = new Set(antes.anexos || []);
        const novosArqs   = todosAnexos(a).filter(f => !velhos.has(f.filename));

        if (reaproveita) {
            r.atividades.push({ nome: a.name, tipo: "tarefa", prazo, link });
            r.tarefasNovas.push(a);
        } else if (tipo) {
            r.prazos.push({ nome: a.name, tipo, antes: antes.duedate, depois: prazo, link });
        }
        if (novosArqs.length && !reaproveita) {
            r.arquivos.push(...novosArqs.map(f => ({ atividade: a.name, arquivo: f.filename })));
            r.anexosNovos.push(...novosArqs);
        }

        const novoRegistro = registroTarefa(a, antes, agoraTs);
        if (reaproveita || tipo || novosArqs.length) r.registrar.push([chave, novoRegistro]);
        else if (JSON.stringify(novoRegistro) !== JSON.stringify(antes)) r.silencio.push([chave, novoRegistro]);
    }

    for (const m of modulos) {
        const chave  = `mod_${m.id}`;
        const antes  = cache[chave];
        const prazos = prazosDoModulo(m);
        const futuro = prazos.filter(t => t > agoraTs).sort((x, y) => x - y)[0] || null;
        if (RASCUNHO.test(m.name)) continue;

        if (!antes) {
            if (prazos.length && !futuro) { r.silencio.push([chave, registroModulo(m, null, agoraTs)]); continue; }
            if (MATERIAIS.has(m.modname))
                r.materiais.push({ nome: m.name, rotulo: rotuloTipo(m), link: m.modname === "url" ? (m.contents?.[0]?.fileurl || m.url) : m.url });
            else
                r.atividades.push({ nome: m.name, tipo: rotuloTipo(m), prazo: futuro, link: m.url });
            r.registrar.push([chave, registroModulo(m, null, agoraTs)]);
            continue;
        }

        if (!antes.datas || JSON.stringify(antes.datas) === JSON.stringify(prazos)) {
            if (!antes.datas || antes.nome !== m.name) r.silencio.push([chave, registroModulo(m, antes, agoraTs)]);
            continue;
        }
        const tipo = classificarPrazo(Math.max(0, ...antes.datas) || null, Math.max(0, ...prazos) || null, agoraTs);
        if (tipo) {
            r.prazos.push({ nome: m.name, tipo, antes: Math.max(0, ...antes.datas) || null, depois: Math.max(...prazos), link: m.url });
            r.registrar.push([chave, registroModulo(m, antes, agoraTs)]);
        } else {
            r.silencio.push([chave, registroModulo(m, antes, agoraTs)]);
        }
    }
    return r;
}

const temNovidade = r => r.atividades.length + r.prazos.length + r.materiais.length + r.arquivos.length > 0;

// ------------------------------------------------------------------ mensagem

const fmtDia = ts => DateTime.fromSeconds(ts).setZone(ZONA).toFormat("dd/MM");

function linhaPrazo(p) {
    if (p.tipo === "reaberto") return `- ${p.nome}: até ${fmtData(p.depois)} (tinha encerrado em ${fmtDia(p.antes)})`;
    if (p.tipo === "definido") return `- ${p.nome}: agora vence ${fmtData(p.depois)}`;
    return `- ${p.nome}: agora vence ${fmtData(p.depois)} (antes: ${fmtData(p.antes)})`;
}

function tituloPrazos(prazos) {
    const tipos = new Set(prazos.map(p => p.tipo));
    const um    = prazos.length === 1;
    if (tipos.size === 1 && tipos.has("reaberto"))  return um ? "Prazo reaberto"  : "Prazos reabertos";
    if (tipos.size === 1 && tipos.has("estendido")) return um ? "Prazo estendido" : "Prazos estendidos";
    return um ? "Prazo alterado" : "Prazos alterados";
}

// Mensagem unica de novidades de uma disciplina
function montarMsgNovidades(disciplina, { atividades = [], prazos = [], materiais = [], arquivos = [] }) {
    const blocos = [`*NOVIDADES EM ${disciplina.toUpperCase()}*`];
    if (atividades.length)
        blocos.push(`*${atividades.length > 1 ? "Atividades novas" : "Atividade nova"}*\n` + atividades.map(a =>
            `- ${a.nome}${a.tipo !== "tarefa" ? ` (${a.tipo})` : ""}` +
            (a.prazo ? `\n  Vence ${fmtData(a.prazo)}` : a.tipo === "tarefa" ? "\n  Sem prazo definido" : "") +
            `\n  ${a.link}`).join("\n\n"));
    if (prazos.length)
        blocos.push(`*${tituloPrazos(prazos)}*\n` + prazos.map(p => `${linhaPrazo(p)}\n  ${p.link}`).join("\n\n"));
    if (materiais.length)
        blocos.push(`*${materiais.length > 1 ? "Materiais" : "Material"}*\n` + materiais.map(m => `- ${m.nome} (${m.rotulo})\n  ${m.link}`).join("\n\n"));
    if (arquivos.length)
        blocos.push(`*Arquivos novos em atividades*\n` + arquivos.map(x => `- ${x.atividade}: ${x.arquivo}`).join("\n"));
    return blocos.join("\n\n");
}

// ------------------------------------------------------------------ verificacao

const gravar = (cache, pares) => { for (const [k, v] of pares) cache[k] = v; return pares.length > 0; };

// Professor alterou a disciplina nos ultimos 30 min? (falha na consulta = nao segura)
async function professorMexendo(courseid, agoraTs) {
    try {
        const alteracoes = await buscarAlteracoesDesde(courseid, agoraTs - QUIETO_S);
        return alteracoes.some(i => (i.updates || []).some(u => EDICAO.has(u.name)));
    } catch { return false; }
}

const verificarNovidades = comGuard("novidades", async () => {
    log("info", "verificarNovidades: inicio");
    const cache   = getCache();
    const agoraTs = agoraS();
    const { cursos, ids } = await cursosDoSemestre();
    const dados   = await retry(() => buscarAtividades([...ids]));
    const tarefasDoCurso = new Map((dados.courses || []).map(c => [c.id, c.assignments || []]));
    const adiados = cache._novidadesAdiadas || (cache._novidadesAdiadas = {});
    let salvou = false, enviadas = 0;

    for (const curso of cursos) {
        let secoes;
        try { secoes = await retry(() => buscarModulos(curso.id)); }
        catch (e) { log("aviso", `verificarNovidades: falha em "${curso.fullname}": ${e.message}`); continue; }

        const tarefas = tarefasDoCurso.get(curso.id) || [];
        const modulos = secoes.flatMap(s => s.modules || [])
            .filter(m => !IGNORADOS.has(m.modname) && m.uservisible !== false && m.visible !== 0);

        // Primeira vez vendo a disciplina: registra tudo sem avisar
        const bases = [`assignbase_${curso.id}`, `modbase_${curso.id}`, `linkbase_${curso.id}`];
        if (bases.some(b => !cache[b])) {
            for (const a of tarefas) cache[`assign_${a.id}`] ||= registroTarefa(a, null, agoraTs);
            for (const m of modulos) cache[`mod_${m.id}`]  ||= registroModulo(m, null, agoraTs);
            for (const b of bases) cache[b] = true;
            salvou = true;
            log("info", `verificarNovidades: "${curso.fullname}" registrado`);
            continue;
        }

        const r = detectar({ tarefas, modulos, cache, agoraTs });
        salvou = gravar(cache, r.silencio) || salvou;
        if (!temNovidade(r)) { delete adiados[curso.id]; continue; }

        // Professor ainda montando a disciplina: espera terminar (com limite)
        const desde = adiados[curso.id];
        if (await professorMexendo(curso.id, agoraTs) && !(desde && agoraTs - desde >= ADIAMENTO_MAX_S)) {
            if (!desde) adiados[curso.id] = agoraTs;
            salvou = true;
            log("info", `verificarNovidades: "${curso.fullname}" teve alteracoes nos ultimos 30 min; aviso na proxima verificacao`);
            continue;
        }
        delete adiados[curso.id];

        const disciplina = normalizarNomeDisciplina(curso.fullname);
        const destinos   = TODOS();
        log("ok", `Novidades em "${curso.fullname}": ${r.atividades.length} atividade(s), ${r.prazos.length} prazo(s), ` +
            `${r.materiais.length} material(is), ${r.arquivos.length} arquivo(s)`);
        await broadcast(montarMsgNovidades(disciplina, r), destinos);
        for (const a of r.tarefasNovas) await enviarDetalhes(destinos, a, `${a.name}\n\n`);
        if (r.anexosNovos.length) await enviarAnexosAtualizados(r.anexosNovos, destinos);

        gravar(cache, r.registrar);
        salvou = true;
        enviadas++;
    }

    if (salvou) { purgarCache(); salvarCache(); }
    log("info", `verificarNovidades: ${enviadas ? `${enviadas} disciplina(s) com novidades` : "nenhuma novidade"}`);
});

module.exports = { verificarNovidades, detectar, montarMsgNovidades, classificarPrazo };
