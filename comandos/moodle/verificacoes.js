'use strict';

const { DateTime } = require("luxon");
const { ZONA, ADMIN, HOST, DISCIPLINAS_IGNORADAS, AULAS_EXTRAS } = require("./config");
const { sleep, agora, log }                             = require("./utils");
const { getCache, salvarCache, purgarCache }            = require("./cache");
const { wa, tg, broadcast }                             = require("./notificacoes");
const { retry }                                         = require("./auth");
const { buscarAtividades, buscarCursos, buscarConteudo, buscarModulos, buscarForunsAvisos, buscarDiscussoes, buscarAulasCalendario } = require("./api");
const { limparHTML, fmtData, fmtHorario, normalizarNomeDisciplina, linkFixo, extrairLinkSala, todosAnexos, linkAtiv } = require("./formatacao");
const { obterLinkDinamico }                             = require("./lti");
const { enviarAtividade, enviarAtividadesAgrupadas, enviarAnexosAtualizados, TODOS } = require("./envios");

// Impede que a mesma verificacao rode em paralelo
const emAndamento = new Set();
function comGuard(nome, fn) {
    return async function () {
        if (emAndamento.has(nome)) { log("aviso", `[${nome}] ja em andamento, pulando.`); return; }
        emAndamento.add(nome);
        try { await fn(); }
        finally { emAndamento.delete(nome); }
    };
}

// IDs dos cursos do semestre atual (cursos de semestres anteriores/repercurso sao ignorados)
async function cursosDoSemestre() {
    const cursos = await retry(() => buscarCursos());
    return { cursos, ids: new Set(cursos.map(c => c.id)) };
}

// Popula cache na primeira execucao (sem enviar notificacoes)
async function popularCacheInicial() {
    log("info", "popularCacheInicial: verificando atividades existentes...");
    const cache = getCache();
    let n = 0;
    try {
        const dados = await retry(() => buscarAtividades());
        for (const curso of dados.courses || [])
            for (const a of curso.assignments || []) {
                const chave = `assign_${a.id}`;
                if (cache[chave]) continue;
                cache[chave] = {
                    timemodified: a.timemodified,
                    duedate:      a.duedate || null,
                    anexos:       todosAnexos(a).map(f => f.filename),
                };
                n++;
            }
        if (n > 0) { salvarCache(); log("ok", `popularCacheInicial: ${n} atividade(s) registrada(s).`); }
        else log("info", "popularCacheInicial: cache ja completo.");
    } catch (e) {
        log("aviso", `popularCacheInicial falhou (nao critico): ${e.message}`);
    }
}

// 06h — Detecta e notifica novas atividades (lancadas nas ultimas 24h)
const verificarNovas = comGuard("novas", async () => {
    log("info", "verificarNovas: inicio");
    const cache  = getCache();
    const { ids } = await cursosDoSemestre();
    const dados  = await retry(() => buscarAtividades());
    const janela = agora().minus({ hours: 24 });
    const novas  = [];

    for (const curso of dados.courses || []) {
        if (!ids.has(curso.id)) continue;
        for (const a of curso.assignments || []) {
            if (cache[`assign_${a.id}`]) continue;
            if (DateTime.fromSeconds(a.timemodified).setZone(ZONA) < janela) continue;
            novas.push({ nomeCurso: curso.fullname, a });
        }
    }

    if (novas.length) {
        for (const { nomeCurso, a } of novas) log("ok", `Nova: "${a.name}" (${nomeCurso})`);
        if (novas.length === 1) await enviarAtividade(TODOS(), novas[0].nomeCurso, novas[0].a);
        else await enviarAtividadesAgrupadas(TODOS(), novas);

        for (const { a } of novas)
            cache[`assign_${a.id}`] = {
                timemodified: a.timemodified,
                duedate:      a.duedate || null,
                anexos:       todosAnexos(a).map(f => f.filename),
            };
        purgarCache(); salvarCache();
    }
    log("info", `verificarNovas: ${novas.length > 0 ? `${novas.length} enviada(s)` : "nenhuma nova"}`);
});

// 10h — Detecta prazos estendidos e novos anexos em atividades ja notificadas
const verificarAtualizacoes = comGuard("atualizacoes", async () => {
    log("info", "verificarAtualizacoes: inicio");
    const cache = getCache();
    const { ids } = await cursosDoSemestre();
    const dados = await retry(() => buscarAtividades());
    let   n     = 0;

    for (const curso of dados.courses || []) {
        if (!ids.has(curso.id)) continue;
        for (const a of curso.assignments || []) {
            const chave   = `assign_${a.id}`;
            const entrada = cache[chave];
            if (!entrada) continue;

            const mudancas = [];
            const dueAtual = a.duedate || null;
            const dueMudou = entrada.duedate !== dueAtual;

            if (dueMudou) {
                const novoEFuturo = dueAtual && DateTime.fromSeconds(dueAtual).setZone(ZONA) > agora();
                if (novoEFuturo) {
                    const antes  = entrada.duedate ? fmtData(entrada.duedate) : "sem prazo";
                    const depois = fmtData(dueAtual);
                    mudancas.push(`- Prazo *estendido*: ${antes} -> *${depois}*`);
                }
            }

            const velhos    = new Set(entrada.anexos || []);
            const novosArqs = todosAnexos(a).filter(f => !velhos.has(f.filename));
            if (novosArqs.length) mudancas.push(`- ${novosArqs.length} novo(s) arquivo(s)`);

            if (!mudancas.length && !dueMudou) continue;

            if (mudancas.length) {
                n++;
                log("ok", `Atualizacao: "${a.name}"`);
                const dest = TODOS();
                await broadcast(
                    `*ATIVIDADE ATUALIZADA*\n\n` +
                    `- Disciplina: ${normalizarNomeDisciplina(curso.fullname)}\n\n` +
                    `- ${a.name}\n\n` +
                    mudancas.join("\n"),
                    dest
                );
                await enviarAnexosAtualizados(novosArqs, dest);
            }

            cache[chave] = {
                timemodified: a.timemodified,
                duedate:      dueAtual,
                anexos:       todosAnexos(a).map(f => f.filename),
            };
            salvarCache();
        }
    }

    log("info", `verificarAtualizacoes: ${n > 0 ? `${n} atualizacao(oes)` : "nenhuma"}`);
});

// Prazos de modulos que nao sao tarefa/forum (quiz, licao, workshop...) a partir dos "dates" do curso
const ROTULO_PRAZO = /vencimento|fecha|prazo/i;
function prazosDoModulo(m) {
    return (m.dates || []).filter(d => d.timestamp && ROTULO_PRAZO.test(d.label)).map(d => d.timestamp);
}

// Monta a mensagem de vencimentos do dia (lista unificada, com aviso de prazo estendido)
function montarMsgVencimentos(lista) {
    const n         = lista.length;
    const estendeu  = i => i.estendidoDe ? ` (prazo estendido, antes: ${fmtData(i.estendidoDe)})` : "";
    const todasEst  = lista.every(i => i.estendidoDe);
    const disciplinas = lista.map(i => normalizarNomeDisciplina(i.curso));
    const prazos      = lista.map(i => fmtData(i.ts));
    const mesmaDisc   = new Set(disciplinas).size === 1;
    const mesmoPrazo  = new Set(prazos).size === 1;
    const links       = lista.map(i => `- ${i.link}`).join("\n");

    if (n === 1) {
        const i = lista[0];
        return `*${i.estendidoDe ? "PRAZO ESTENDIDO — " : ""}ATIVIDADE VENCE HOJE*\n\n` +
               `- Disciplina: ${disciplinas[0]}\n- ${i.nome}\n- Vencimento: ${prazos[0]}\n` +
               (i.estendidoDe ? `\nJa avisamos dessa atividade antes: o prazo era ${fmtData(i.estendidoDe)} e foi estendido.\n` : "") +
               `\nLink: ${i.link}`;
    }
    const titulo = todasEst ? `${n} ATIVIDADES COM PRAZO ESTENDIDO VENCEM HOJE` : `${n} ATIVIDADES VENCEM HOJE`;
    const aviso  = lista.some(i => i.estendidoDe) && !todasEst
        ? `\n\nAs marcadas como "prazo estendido" ja foram avisadas antes.` : "";
    if (mesmaDisc) {
        const itens = lista.map((i, k) => `- ${i.nome}${mesmoPrazo ? "" : ` — ${prazos[k]}`}${estendeu(i)}`).join("\n");
        return `*${mesmaDisc && !todasEst ? `${n} ATIVIDADES DE ${disciplinas[0].toUpperCase()} VENCEM HOJE` : titulo}*\n\n${itens}\n\nLinks:\n${links}` +
               (mesmoPrazo ? `\n\nVencimento: ${prazos[0]}` : "") + aviso;
    }
    const itens = lista.map((i, k) => `- ${disciplinas[k]}: ${i.nome}${mesmoPrazo ? "" : ` — ${prazos[k]}`}${estendeu(i)}`).join("\n");
    return `*${titulo}*\n\n${itens}\n\nLinks:\n${links}` + (mesmoPrazo ? `\n\nVencimento: ${prazos[0]}` : "") + aviso;
}

// 12h — Notifica atividades (tarefas, quiz, licoes...) que vencem hoje
const verificarVencimentos = comGuard("vencimentos", async () => {
    log("info", "verificarVencimentos: inicio");
    const cache = getCache();
    const { cursos, ids } = await cursosDoSemestre();
    const dados = await retry(() => buscarAtividades());
    const now   = agora();
    const fim   = now.startOf("day").plus({ days: 1, hours: 2 });
    const noDia = ts => { const dt = DateTime.fromSeconds(ts).setZone(ZONA); return dt >= now && dt <= fim; };
    const porCmid = new Map();

    for (const curso of dados.courses || []) {
        if (!ids.has(curso.id)) continue;
        for (const a of curso.assignments || [])
            if (a.duedate && noDia(a.duedate))
                porCmid.set(a.cmid, { cmid: a.cmid, curso: curso.fullname, nome: a.name, ts: a.duedate, link: linkAtiv(a.cmid) });
    }

    // Outros tipos de modulo (quiz, licao, workshop...). Tarefas e foruns tem fluxo proprio.
    for (const curso of cursos) {
        let secoes;
        try { secoes = await retry(() => buscarModulos(curso.id)); }
        catch (e) { log("aviso", `verificarVencimentos: falha em "${curso.fullname}": ${e.message}`); continue; }

        for (const m of secoes.flatMap(s => s.modules || [])) {
            if (["assign", "forum", "label", "url"].includes(m.modname)) continue;
            if (m.uservisible === false || m.visible === 0 || porCmid.has(m.id)) continue;
            if (m.completiondata?.state >= 1) continue; // ja concluida pelo aluno
            const ts = prazosDoModulo(m).filter(noDia).sort((x, y) => x - y)[0];
            if (ts) porCmid.set(m.id, { cmid: m.id, curso: curso.fullname, nome: m.name, ts, link: m.url });
        }
    }

    const lista = [...porCmid.values()].sort((x, y) => x.ts - y.ts);
    log("info", `verificarVencimentos: ${lista.length > 0 ? `${lista.length} vencendo` : "nenhuma"}`);
    if (!lista.length) return;

    // Atividade ja avisada antes com outro prazo = prazo estendido
    for (const i of lista) {
        const anterior = cache[`venc_${i.cmid}`]?.duedate;
        i.estendidoDe = anterior && anterior !== i.ts ? anterior : null;
    }

    await broadcast(montarMsgVencimentos(lista), TODOS());

    for (const i of lista) cache[`venc_${i.cmid}`] = { duedate: i.ts };
    salvarCache();
});

// 15h — Detecta novos links adicionados nas disciplinas (ultimas 24h), numa unica mensagem
const verificarLinks = comGuard("links", async () => {
    log("info", "verificarLinks: inicio");
    const { cursos } = await cursosDoSemestre();
    const janela = agora().minus({ hours: 24 });
    const grupos = [];

    for (const curso of cursos) {
        let secoes;
        try { secoes = await retry(() => buscarConteudo(curso.id)); }
        catch (e) {
            log("aviso", `Falha ao buscar conteudo de "${curso.fullname}": ${e.message}`);
            await wa(ADMIN, `*Moodle Monitor*\nFalha nos links de "${curso.fullname}":\n${e.message}`);
            continue;
        }

        const novos = [];
        for (const secao of secoes)
            for (const mod of (secao.modules || [])) {
                if (mod.modname !== "url") continue;
                const cnt = mod.contents?.[0];
                if (!cnt || DateTime.fromSeconds(cnt.timemodified).setZone(ZONA) < janela) continue;
                novos.push({ nome: mod.name, url: cnt.fileurl });
            }
        if (!novos.length) continue;
        log("ok", `${novos.length} link(s) novo(s) em "${curso.fullname}"`);
        grupos.push({ disciplina: normalizarNomeDisciplina(curso.fullname), novos });
    }

    const total = grupos.reduce((s, g) => s + g.novos.length, 0);
    if (total) {
        const fmt = ls => ls.map(l => `- ${l.nome}\n  ${l.url}`).join("\n\n");
        let msg;
        if (grupos.length === 1)
            msg = `*${total > 1 ? "NOVOS LINKS" : "NOVO LINK"} EM ${grupos[0].disciplina.toUpperCase()}*\n\n${fmt(grupos[0].novos)}`;
        else
            msg = `*${total} NOVOS LINKS*\n\n` + grupos.map(g => `*${g.disciplina}*\n${fmt(g.novos)}`).join("\n\n");
        await broadcast(msg, TODOS());
    }
    log("info", `verificarLinks: ${total > 0 ? `${total} link(s)` : "nenhum novo"}`);
});

// Modulos tratados por outras verificacoes (ou sem conteudo relevante)
const MODULOS_IGNORADOS = new Set(["label", "assign", "url"]);

const NOMES_TIPO = {
    quiz: "QUESTIONARIO", forum: "FORUM", lesson: "LICAO", workshop: "WORKSHOP", choice: "ENQUETE",
    feedback: "PESQUISA", survey: "PESQUISA", data: "BANCO DE DADOS", glossary: "GLOSSARIO",
    h5pactivity: "ATIVIDADE H5P", scorm: "PACOTE SCORM", resource: "ARQUIVO", folder: "PASTA",
    page: "PAGINA", book: "LIVRO", wiki: "WIKI", lti: "FERRAMENTA EXTERNA", bigbluebuttonbn: "SALA VIRTUAL",
};

// Datas do modulo formatadas com rotulo em portugues ("Encerra: 12/10 as 23h59")
function linhasDatas(m) {
    return (m.dates || []).filter(d => d.timestamp).map(d => {
        const rotulo = d.label.replace(/:\s*$/, "");
        const futuro = d.timestamp > agora().toSeconds();
        const nome   = /^fechad/i.test(rotulo) ? (futuro ? "Encerra" : "Encerrou")
                     : /^abert/i.test(rotulo)  ? (futuro ? "Abre"    : "Abriu")
                     : rotulo;
        return `- ${nome}: ${fmtData(d.timestamp)}`;
    }).join("\n");
}

// Detecta qualquer modulo novo (quiz, forum, licao, arquivo...) e mudancas de prazo nos existentes.
// Usa o ID do modulo como chave: nao depende de datas nem de formato da atividade.
const verificarModulos = comGuard("modulos", async () => {
    log("info", "verificarModulos: inicio");
    const cache  = getCache();
    const { cursos } = await cursosDoSemestre();
    const novos    = [];
    const alterados = [];
    let   salvou   = false;

    for (const curso of cursos) {
        let secoes;
        try { secoes = await retry(() => buscarModulos(curso.id)); }
        catch (e) {
            log("aviso", `verificarModulos: falha em "${curso.fullname}": ${e.message}`);
            continue;
        }

        const modulos = secoes.flatMap(s => s.modules || [])
            .filter(m => !MODULOS_IGNORADOS.has(m.modname) && m.uservisible !== false && m.visible !== 0);
        const registro = m => ({ nome: m.name, tipo: m.modname, datas: prazosDoModulo(m) });

        // Primeira vez vendo o curso: registra o que ja existe sem notificar
        const chaveBase = `modbase_${curso.id}`;
        if (!cache[chaveBase]) {
            for (const m of modulos) cache[`mod_${m.id}`] = registro(m);
            cache[chaveBase] = true;
            salvou = true;
            log("info", `verificarModulos: "${curso.fullname}" registrado (${modulos.length} modulo(s))`);
            continue;
        }

        for (const m of modulos) {
            const chave = `mod_${m.id}`;
            const antes = cache[chave];
            if (!antes) { novos.push({ curso, m }); continue; }

            const datas = prazosDoModulo(m);
            if (!antes.datas) { cache[chave] = registro(m); salvou = true; continue; } // entrada antiga: so atualiza
            if (JSON.stringify(antes.datas) !== JSON.stringify(datas)) {
                if (datas.some(ts => ts > agora().toSeconds())) alterados.push({ curso, m, antes: antes.datas, depois: datas });
                else { cache[chave] = registro(m); salvou = true; }
            }
        }
    }

    const fmtPrazos = ts => ts.length ? ts.map(fmtData).join(" / ") : "sem prazo";
    const tipoDe    = m => NOMES_TIPO[m.modname] || m.modname.toUpperCase();

    if (novos.length) {
        for (const { curso, m } of novos) log("ok", `Novo modulo [${m.modname}]: "${m.name}" (${curso.fullname})`);
        let msg;
        if (novos.length === 1) {
            const { curso, m } = novos[0];
            const datas = linhasDatas(m);
            const desc  = limparHTML(m.description);
            msg = `*NOVO ${tipoDe(m)} NO MOODLE*\n\n` +
                  `- Disciplina: ${normalizarNomeDisciplina(curso.fullname)}\n\n- ${m.name}` +
                  (datas ? `\n\n${datas}` : "") +
                  `\n\nLink: ${m.url}` +
                  (desc ? `\n\nDescricao:\n\n\`\`\`\n${desc}\n\`\`\`` : "");
        } else {
            const porCurso = new Map();
            for (const x of novos) porCurso.set(x.curso.id, [...(porCurso.get(x.curso.id) || []), x]);
            const blocos = [...porCurso.values()].map(xs =>
                `*${normalizarNomeDisciplina(xs[0].curso.fullname)}*\n` +
                xs.map(({ m }) => {
                    const datas = linhasDatas(m).replace(/^- /gm, "  ");
                    return `- [${tipoDe(m)}] ${m.name}${datas ? `\n${datas}` : ""}\n  ${m.url}`;
                }).join("\n\n")
            );
            msg = `*${novos.length} NOVOS ITENS NO MOODLE*\n\n${blocos.join("\n\n")}`;
        }
        await broadcast(msg, TODOS());
        for (const { m } of novos) cache[`mod_${m.id}`] = { nome: m.name, tipo: m.modname, datas: prazosDoModulo(m) };
        salvou = true;
    }

    if (alterados.length) {
        for (const { curso, m } of alterados) log("ok", `Prazo alterado [${m.modname}]: "${m.name}" (${curso.fullname})`);
        const itens = alterados.map(({ curso, m, antes, depois }) =>
            `- ${normalizarNomeDisciplina(curso.fullname)}: ${m.name}\n  Antes: ${fmtPrazos(antes)}\n  Agora: *${fmtPrazos(depois)}*\n  ${m.url}`
        ).join("\n\n");
        await broadcast(
            `*${alterados.length > 1 ? `${alterados.length} PRAZOS ALTERADOS` : "PRAZO ALTERADO"}*\n\n${itens}`,
            TODOS()
        );
        for (const { m, depois } of alterados) cache[`mod_${m.id}`] = { nome: m.name, tipo: m.modname, datas: depois };
        salvou = true;
    }

    if (salvou) salvarCache();
    log("info", `verificarModulos: ${novos.length} novo(s), ${alterados.length} prazo(s) alterado(s)`);
});

// Detecta novos avisos postados pelos professores nos foruns de avisos
const verificarAvisos = comGuard("avisos", async () => {
    log("info", "verificarAvisos: inicio");
    const cache = getCache();
    const { cursos } = await cursosDoSemestre();
    const foruns = await retry(() => buscarForunsAvisos(cursos.map(c => c.id)));
    const novos  = [];
    let   salvou = false;

    for (const forum of foruns) {
        const curso = cursos.find(c => c.id === forum.course);
        if (!curso) continue;
        let discussoes;
        try { discussoes = await retry(() => buscarDiscussoes(forum.id)); }
        catch (e) { log("aviso", `verificarAvisos: falha em "${curso.fullname}": ${e.message}`); continue; }

        const chaveBase = `avisobase_${curso.id}`;
        const primeira  = !cache[chaveBase];
        for (const d of discussoes) {
            const chave = `aviso_${d.discussion}`;
            if (cache[chave]) continue;
            cache[chave] = true; salvou = true;
            if (!primeira) novos.push({ curso, d });
        }
        if (primeira) { cache[chaveBase] = true; salvou = true; }
    }

    // Cada aviso vai em mensagem propria: o texto do professor e o conteudo principal
    for (const { curso, d } of novos.reverse()) {
        log("ok", `Novo aviso: "${d.subject}" (${curso.fullname})`);
        let texto = limparHTML(d.message);
        if (texto.length > 1500) texto = texto.slice(0, 1500).trimEnd() + "...";
        await broadcast(
            `*NOVO AVISO EM ${normalizarNomeDisciplina(curso.fullname).toUpperCase()}*\n\n` +
            `*${(d.subject || d.name || "").trim()}*\n` +
            (d.userfullname ? `Por ${d.userfullname}\n` : "") +
            (texto ? `\n${texto}\n` : "") +
            `\nLink: https://${HOST}/mod/forum/discuss.php?d=${d.discussion}`,
            TODOS()
        );
    }

    if (salvou) salvarCache();
    log("info", `verificarAvisos: ${novos.length > 0 ? `${novos.length} novo(s)` : "nenhum novo"}`);
});

// 14h — Notifica foruns com prazo hoje (mensagem unica)
const verificarForuns = comGuard("foruns", async () => {
    log("info", "verificarForuns: inicio");
    const now = agora();
    const { ids } = await cursosDoSemestre();

    let eventos;
    try { eventos = await retry(() => buscarAulasCalendario(now.year, now.month, now.day)); }
    catch (e) {
        log("erro", `verificarForuns: falha no calendario: ${e.message}`);
        await tg(`*Moodle Monitor*\nFalha ao buscar calendario para foruns:\n${e.message}`);
        return;
    }

    const dataStr = now.toISODate();
    const cache   = getCache();
    const foruns  = eventos.filter(e => {
        if (e.modulename !== "forum" || e.eventtype !== "due") return false;
        if (e.course?.id && !ids.has(e.course.id)) return false;
        if (cache[`forum_${e.id}_${dataStr}`]) return false;
        return true;
    });

    log("info", `verificarForuns: ${foruns.length > 0 ? `${foruns.length} forum(ns)` : "nenhum"}`);
    if (!foruns.length) return;

    const itens = foruns.map(f => ({
        disciplina: normalizarNomeDisciplina(f.course?.fullname || ""),
        horario:    fmtHorario(f.timestart),
        link:       f.action?.url || f.url || "(nao encontrado)",
        nome:       f.name.replace(/\s*e devido\s*$/i, "").trim(),
    }));
    for (const i of itens) log("ok", `Forum: "${i.nome}" prazo as ${i.horario}`);

    let msg;
    if (itens.length === 1) {
        const i = itens[0];
        msg = `*FORUM COM PRAZO HOJE*\n\n- Disciplina: ${i.disciplina}\n\n- ${i.nome}\n\n- Prazo: ${i.horario}\n\n- Link: ${i.link}`;
    } else {
        msg = `*${itens.length} FORUNS COM PRAZO HOJE*\n\n` +
              itens.map(i => `- ${i.disciplina}: ${i.nome}\n  Prazo: ${i.horario}\n  ${i.link}`).join("\n\n");
    }
    await broadcast(msg, TODOS());

    for (const f of foruns) cache[`forum_${f.id}_${dataStr}`] = true;
    salvarCache();
});

// 18h / 19h / 20h — Notifica aulas que vao acontecer (com deduplicacao entre checks)
const verificarAulasHoje = comGuard("aulas", async () => {
    log("info", "verificarAulasHoje: inicio");
    const now = agora();
    const { ids } = await cursosDoSemestre();

    let eventos;
    try { eventos = await retry(() => buscarAulasCalendario(now.year, now.month, now.day)); }
    catch (e) {
        log("erro", `verificarAulasHoje: falha no calendario: ${e.message}`);
        await tg(`*Moodle Monitor*\nFalha ao buscar aulas:\n${e.message}`);
        return;
    }

    const fim     = now.plus({ days: 1 }).set({ hour: 2, minute: 0, second: 0, millisecond: 0 });
    const dataStr = now.toISODate();
    const cache   = getCache();

    // Aulas futuras do dia, so de cursos do semestre atual, sem disciplinas ignoradas
    const aulas = eventos
        .filter(e => {
            if (!e.iscourseevent || e.isactionevent) return false;
            if (e.course?.id && !ids.has(e.course.id)) return false;
            if (DISCIPLINAS_IGNORADAS.has((e.course?.fullname || "").toLowerCase())) return false;
            const ts = DateTime.fromSeconds(e.timestart).setZone(ZONA);
            return ts >= now && ts <= fim;
        })
        .sort((a, b) => a.timestart - b.timestart);

    // Agrupa eventos duplicados: mesmo curso + mesmo link de sala em ate 2h de diferenca
    // (ex.: "Atendimento 19h30" e "Aula 20h" na mesma sala viram uma so)
    const grupos = [];
    for (const aula of aulas) {
        const sala = extrairLinkSala(aula.description) || aula.name;
        const g = grupos.find(x => x.curso === aula.course?.id && x.sala === sala && aula.timestart - x.aula.timestart <= 7200);
        if (g) g.ids.push(aula.id);
        else grupos.push({ curso: aula.course?.id, sala, aula, ids: [aula.id] });
    }
    log("info", `verificarAulasHoje: ${grupos.length > 0 ? `${grupos.length} aula(s)` : "nenhuma"}`);

    const itens = []; // { disciplina, horario, link, minutosAte, chaves }
    for (const g of grupos) {
        if (g.ids.some(id => cache[`aula_${id}_${dataStr}`])) continue;
        const disciplina   = normalizarNomeDisciplina(g.aula.course?.fullname || "");
        const linkDinamico = await obterLinkDinamico(g.aula.description);
        const ts           = DateTime.fromSeconds(g.aula.timestart).setZone(ZONA);
        itens.push({
            disciplina,
            horario:    fmtHorario(g.aula.timestart),
            link:       linkDinamico || linkFixo(disciplina) || extrairLinkSala(g.aula.description),
            minutosAte: Math.round(ts.diff(now, "minutes").minutes),
            chaves:     g.ids.map(id => `aula_${id}_${dataStr}`),
            valor:      true,
        });
    }

    // Aulas extras: disciplinas sem evento no calendario mas com horario fixo configurado
    const diaSemana = now.weekday;
    const linksAvulsos = [];
    for (const extra of AULAS_EXTRAS.filter(a => a.diaSemana === diaSemana)) {
        const chaveCache = `extra_${extra.disciplina}_${dataStr}`;
        if (cache[chaveCache] === "link") continue;

        const [h, m] = extra.horario.split(":").map(Number);
        const tsExtra = now.set({ hour: h, minute: m, second: 0, millisecond: 0 });
        if (tsExtra < now || tsExtra > fim) continue;

        const disc = extra.disciplina;
        // Ja existe evento do calendario para essa disciplina no dia: nao duplica
        if (itens.some(i => i.disciplina.toLowerCase() === disc.toLowerCase()) ||
            grupos.some(g => normalizarNomeDisciplina(g.aula.course?.fullname || "").toLowerCase() === disc.toLowerCase())) continue;

        let linkDinamico = null;
        if (extra.cmid) {
            try { linkDinamico = await obterLinkDinamico(`mod/lti/view.php?id=${extra.cmid}`); }
            catch (e) { log("aviso", `[extra] falha LTI cmid=${extra.cmid}: ${e.message}`); }
        }
        const link = linkDinamico || linkFixo(disc) || null;

        // Se ja enviou sem link, so reenvia quando encontrar o link
        if (cache[chaveCache] === "sem" && !link) continue;

        if (cache[chaveCache] === "sem" && link) { linksAvulsos.push({ disc, link, chaveCache }); continue; }

        itens.push({
            disciplina: disc, horario: extra.horario, link, semLink: "(sessao nao agendada)",
            minutosAte: Math.round(tsExtra.diff(now, "minutes").minutes),
            chaves: [chaveCache], valor: link ? "link" : "sem",
        });
    }

    for (const i of itens)
        log("ok", `Aula: "${i.disciplina}" as ${i.horario} (em ${i.minutosAte} min) link=${i.link ? "ok" : "sem"}`);

    if (itens.length) {
        itens.sort((a, b) => a.minutosAte - b.minutosAte);
        const maisCedo = itens[0].minutosAte;
        const chamada  = maisCedo < 10 ? "JA VAI COMECAR" : maisCedo < 30 ? "JAJA TEM AULA" : "MAIS TARDE TEM AULA";
        let msg;
        if (itens.length === 1) {
            const i = itens[0];
            const titulo = i.minutosAte < 10  ? `*AULA DE ${i.disciplina.toUpperCase()} JA VAI COMECAR*`
                         : i.minutosAte < 30  ? `*JAJA TEM AULA DE ${i.disciplina.toUpperCase()}*`
                         :                      `*MAIS TARDE TEM AULA DE ${i.disciplina.toUpperCase()}*`;
            msg = `${titulo}\n\n- Horario: ${i.horario}\n\n- Link: ${i.link || i.semLink || "(nao encontrado)"}`;
        } else {
            msg = `*${chamada} — ${itens.length} AULAS*\n\n` +
                  itens.map(i => `- ${i.disciplina.toUpperCase()}\n  Horario: ${i.horario}\n  Link: ${i.link || i.semLink || "(nao encontrado)"}`).join("\n\n");
        }
        await broadcast(msg, TODOS());
        for (const i of itens) for (const c of i.chaves) cache[c] = i.valor;
    }

    for (const l of linksAvulsos) {
        await broadcast(`*LINK DA AULA DE ${l.disc.toUpperCase()}*\n\n- Link: ${l.link}`, TODOS());
        cache[l.chaveCache] = "link";
    }

    if (itens.length || linksAvulsos.length) salvarCache();
});

module.exports = {
    popularCacheInicial,
    verificarNovas, verificarModulos, verificarAvisos, verificarAtualizacoes, verificarVencimentos,
    verificarLinks, verificarForuns, verificarAulasHoje, montarMsgVencimentos,
};
