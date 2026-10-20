'use strict';

const { DateTime } = require("luxon");
const { ZONA, ADMIN, HOST, DISCIPLINAS_IGNORADAS, AULAS_EXTRAS } = require("./config");
const { sleep, agora, log }                             = require("./utils");
const { getCache, salvarCache, purgarCache }            = require("./cache");
const { wa, tg, broadcast }                             = require("./notificacoes");
const { retry }                                         = require("./auth");
const {
    buscarAtividades, buscarModulos, buscarForunsAvisos, buscarDiscussoes, buscarAulasCalendario,
    buscarNotasGerais, buscarNotasCurso, buscarStatusTarefa, buscarNomeUsuario, buscarNomeCurso,
} = require("./api");
const { limparHTML, fmtData, fmtHorario, normalizarNomeDisciplina, linkFixo, extrairLinkSala, todosAnexos, linkAtiv } = require("./formatacao");
const { textoFalta, decidirLembrete } = require("./lembretes");
const { obterLinkDinamico }                             = require("./lti");
const { enviarTextoOuArquivo, LIMITE_TEXTO, TODOS } = require("./envios");
const { comGuard, cursosDoSemestre, prazosDoModulo, agoraS } = require("./comum");

// Monta a mensagem de vencimentos do dia (lista unificada, com aviso de prazo estendido)
function montarMsgVencimentos(lista) {
    const n         = lista.length;
    const estendeu  = i => i.estendidoDe ? ` (prazo ${i.estendidoDe < i.ts ? "estendido" : "alterado"}, antes: ${fmtData(i.estendidoDe)})` : "";
    const todasEst  = lista.every(i => i.estendidoDe && i.estendidoDe < i.ts);
    const disciplinas = lista.map(i => normalizarNomeDisciplina(i.curso));
    const prazos      = lista.map(i => fmtData(i.ts));
    const mesmaDisc   = new Set(disciplinas).size === 1;
    const mesmoPrazo  = new Set(prazos).size === 1;
    const links       = lista.map(i => `- ${i.link}`).join("\n");

    if (n === 1) {
        const i   = lista[0];
        const ext = i.estendidoDe && i.estendidoDe < i.ts;
        return `*${i.estendidoDe ? (ext ? "PRAZO ESTENDIDO — " : "PRAZO ALTERADO — ") : ""}ATIVIDADE VENCE HOJE*\n\n` +
               `- Disciplina: ${disciplinas[0]}\n- ${i.nome}\n- Vencimento: ${prazos[0]}\n` +
               (i.estendidoDe ? `\nJa avisei dessa atividade antes: o prazo era ${fmtData(i.estendidoDe)} e foi ${ext ? "estendido" : "alterado"}.\n` : "") +
               `\nLink: ${i.link}`;
    }
    const titulo = todasEst ? `${n} ATIVIDADES COM PRAZO ESTENDIDO VENCEM HOJE` : `${n} ATIVIDADES VENCEM HOJE`;
    const aviso  = lista.some(i => i.estendidoDe) && !todasEst
        ? `\n\nAs marcadas com prazo estendido/alterado eu ja avisei antes.` : "";
    if (mesmaDisc) {
        const itens = lista.map((i, k) => `- ${i.nome}${mesmoPrazo ? "" : ` — ${prazos[k]}`}${estendeu(i)}`).join("\n");
        return `*${mesmaDisc && !todasEst ? `${n} ATIVIDADES DE ${disciplinas[0].toUpperCase()} VENCEM HOJE` : titulo}*\n\n${itens}\n\nLinks:\n${links}` +
               (mesmoPrazo ? `\n\nVencimento: ${prazos[0]}` : "") + aviso;
    }
    const itens = lista.map((i, k) => `- ${disciplinas[k]}: ${i.nome}${mesmoPrazo ? "" : ` — ${prazos[k]}`}${estendeu(i)}`).join("\n");
    return `*${titulo}*\n\n${itens}\n\nLinks:\n${links}` + (mesmoPrazo ? `\n\nVencimento: ${prazos[0]}` : "") + aviso;
}

// Nome limpo do evento de prazo do calendario ("X está marcado(a) para esta data", "Término de X", "X é devido")
function nomeDoEvento(nome) {
    return (nome || "")
        .replace(/^(Término|Termino|Fechamento|Encerramento|Fim) d[eoa]\s+/i, "")
        .replace(/\s+(está marcado\(a\) para esta data|é devido|e devido|fecha|closes|is due)\s*$/i, "")
        .trim();
}

// Eventos de prazo: qualquer tipo de modulo, menos abertura e "conclusao esperada"
const ehEventoPrazo = e => e.modulename && /due|close|deadline/i.test(e.eventtype || "") && !/open/i.test(e.eventtype || "");

// 12h — Notifica atividades (tarefas, quiz, licoes...) que vencem hoje.
// Fonte: calendario do dia (1 requisicao para todas as disciplinas) + tarefas (mod_assign) como reforco.
// Nao depende do progresso de quem roda o bot: atividade ja entregue continua sendo avisada para a turma.
const verificarVencimentos = comGuard("vencimentos", async () => {
    log("info", "verificarVencimentos: inicio");
    const cache   = getCache();
    const { ids } = await cursosDoSemestre();
    const now     = agora();
    const hoje    = now.toISODate();
    const fim     = now.startOf("day").plus({ days: 1, hours: 2 });
    const noDia   = ts => { const dt = DateTime.fromSeconds(ts).setZone(ZONA); return dt >= now && dt <= fim; };
    const porCmid = new Map();

    const dados = await retry(() => buscarAtividades([...ids]));
    for (const curso of dados.courses || []) {
        if (!ids.has(curso.id)) continue;
        for (const a of curso.assignments || [])
            if (a.duedate && noDia(a.duedate))
                porCmid.set(a.cmid, { cmid: a.cmid, curso: curso.fullname, nome: a.name, ts: a.duedate, link: linkAtiv(a.cmid) });
    }

    // Calendario de hoje e de amanha (prazos ate 02h contam como "hoje"). Foruns tem verificacao propria (14h).
    const amanha  = now.plus({ days: 1 });
    const eventos = [
        ...await retry(() => buscarAulasCalendario(now.year, now.month, now.day)),
        ...await retry(() => buscarAulasCalendario(amanha.year, amanha.month, amanha.day)),
    ];
    for (const e of eventos) {
        if (!ehEventoPrazo(e) || e.modulename === "forum") continue;
        if (!e.course?.id || !ids.has(e.course.id) || !noDia(e.timestart)) continue;
        const cmid = Number((e.url || "").match(/[?&]id=(\d+)/)?.[1]) || e.instance;
        if (porCmid.has(cmid)) continue;
        porCmid.set(cmid, { cmid, curso: e.course.fullname, nome: nomeDoEvento(e.name), ts: e.timestart, link: e.url });
    }

    // Ignora o que ja foi avisado hoje com o mesmo prazo (ex.: bot reiniciado e rodou de novo)
    const lista = [...porCmid.values()]
        .filter(i => !(cache[`venc_${i.cmid}`]?.duedate === i.ts && cache[`venc_${i.cmid}`]?.dia === hoje))
        .sort((x, y) => x.ts - y.ts);
    log("info", `verificarVencimentos: ${lista.length > 0 ? `${lista.length} vencendo` : "nenhuma"}`);
    if (!lista.length) return;

    // Atividade ja avisada antes com outro prazo = prazo estendido (ou alterado)
    for (const i of lista) {
        const anterior = cache[`venc_${i.cmid}`]?.duedate;
        i.estendidoDe = anterior && anterior !== i.ts ? anterior : null;
    }

    await broadcast(montarMsgVencimentos(lista), TODOS());

    for (const i of lista) cache[`venc_${i.cmid}`] = { duedate: i.ts, dia: hoje };
    salvarCache();
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
        const texto = limparHTML(d.message);
        const longo = texto.length > LIMITE_TEXTO;
        await broadcast(
            `*NOVO AVISO EM ${normalizarNomeDisciplina(curso.fullname).toUpperCase()}*\n\n` +
            `*${(d.subject || d.name || "").trim()}*\n` +
            (d.userfullname ? `Por ${d.userfullname}\n` : "") +
            (texto && !longo ? `\n${texto}\n` : "") +
            `\nLink: https://${HOST}/mod/forum/discuss.php?d=${d.discussion}`,
            TODOS()
        );
        if (longo) await enviarTextoOuArquivo(TODOS(), "Texto do aviso", texto, "aviso.txt");
    }

    if (salvou) salvarCache();
    log("info", `verificarAvisos: ${novos.length > 0 ? `${novos.length} novo(s)` : "nenhum novo"}`);
});

// Dias de calendario ate o prazo (prazo "a meia-noite" conta como o dia anterior)
function diasAte(prazoTs, now = agora()) {
    const dia = DateTime.fromSeconds(prazoTs - 60).setZone(ZONA).startOf("day");
    return Math.round(dia.diff(now.startOf("day"), "days").days);
}

// 12h — Lembretes intermediarios ("faltam 2 semanas"), distribuidos conforme a duracao do prazo.
// Ver lembretes.js para a regra. Vale para tarefas e qualquer modulo com prazo (quiz, forum, licao...).
const verificarLembretes = comGuard("lembretes", async () => {
    log("info", "verificarLembretes: inicio");
    const cache = getCache();
    const { cursos, ids } = await cursosDoSemestre();
    const now   = agora();
    const itens = new Map(); // cmid -> { curso, nome, prazo, inicio, link }

    const dados = await retry(() => buscarAtividades([...ids]));
    for (const curso of dados.courses || []) {
        if (!ids.has(curso.id)) continue;
        for (const a of curso.assignments || []) {
            if (!a.duedate || a.duedate <= now.toSeconds()) continue;
            const visto  = cache[`assign_${a.id}`]?.visto;
            const inicio = a.allowsubmissionsfromdate || Math.min(visto ?? Infinity, a.timemodified);
            itens.set(a.cmid, { curso: curso.fullname, nome: a.name, prazo: a.duedate, inicio, link: linkAtiv(a.cmid) });
        }
    }

    for (const curso of cursos) {
        let secoes;
        try { secoes = await retry(() => buscarModulos(curso.id)); }
        catch (e) { log("aviso", `verificarLembretes: falha em "${curso.fullname}": ${e.message}`); continue; }
        for (const m of secoes.flatMap(s => s.modules || [])) {
            if (m.modname === "assign" || itens.has(m.id) || m.uservisible === false || m.visible === 0) continue;
            const prazo = prazosDoModulo(m).filter(ts => ts > now.toSeconds()).sort((x, y) => x - y)[0];
            if (!prazo) continue;
            const abre   = (m.dates || []).find(d => /abert|abre|abriu|open/i.test(d.label))?.timestamp;
            const inicio = abre || cache[`mod_${m.id}`]?.visto || agoraS();
            itens.set(m.id, { curso: curso.fullname, nome: m.name, prazo, inicio, link: m.url });
        }
    }

    const lista = [];
    for (const [cmid, i] of itens) {
        const diasRestantes = diasAte(i.prazo, now);
        const { enviar, novoEstado } = decidirLembrete({
            inicioTs: i.inicio, prazoTs: i.prazo, diasRestantes, estado: cache[`lemb_${cmid}`],
        });
        cache[`lemb_${cmid}`] = novoEstado;
        if (enviar) lista.push({ ...i, diasRestantes });
    }
    salvarCache();
    log("info", `verificarLembretes: ${lista.length ? `${lista.length} lembrete(s)` : "nenhum"}`);
    if (!lista.length) return;

    lista.sort((x, y) => x.prazo - y.prazo);
    const falta = i => i.diasRestantes === 1 ? "Vence amanha" : `Faltam ${textoFalta(i.diasRestantes)}`;
    let msg;
    if (lista.length === 1) {
        const i = lista[0];
        msg = `*LEMBRETE: ${falta(i).toUpperCase()}*\n\n` +
              `- Disciplina: ${normalizarNomeDisciplina(i.curso)}\n- ${i.nome}\n- Vencimento: ${fmtData(i.prazo)}\n\nLink: ${i.link}`;
    } else {
        msg = `*LEMBRETE DE PRAZOS*\n\n` + lista.map(i =>
            `- ${normalizarNomeDisciplina(i.curso)}: ${i.nome}\n  ${falta(i)} (vence ${fmtData(i.prazo)})\n  ${i.link}`
        ).join("\n\n");
    }
    for (const i of lista) log("ok", `Lembrete: "${i.nome}" — ${falta(i)}`);
    await broadcast(msg, TODOS());
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
        nome:       nomeDoEvento(f.name),
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

// Formata nota: "9.60 / 10.00" (escalas usam o texto do Moodle)
function fmtNota(it) {
    if (it.scaleid) return it.gradeformatted;
    const n = v => Number(v).toFixed(2);
    return `${n(it.graderaw)} / ${n(it.grademax)}`;
}

// Quem corrigiu e o feedback. So tarefas (assign) informam o corretor; quiz/H5P/LTI sao automaticos.
async function detalhesCorrecao(it) {
    let corretor = null, feedback = limparHTML(it.feedback);
    if (it.itemmodule === "assign") {
        try {
            const s  = await retry(() => buscarStatusTarefa(it.iteminstance));
            const id = s.feedback?.grade?.grader;
            if (id > 0) corretor = await buscarNomeUsuario(id).catch(() => null);
            const comentarios = (s.feedback?.plugins || [])
                .flatMap(p => p.editorfields || []).map(f => limparHTML(f.text)).filter(Boolean).join("\n\n");
            if (comentarios) feedback = comentarios;
        } catch (e) { log("aviso", `verificarNotas: detalhes de "${it.itemname}" falharam: ${e.message}`); }
    }
    return { corretor, feedback };
}

// A cada hora — Notas novas ou alteradas, de qualquer tipo de atividade. Avisa SO o admin (nota e pessoal).
// Detector: 1 requisicao com o total de todos os cursos; cursos do semestre sao sempre conferidos item a item,
// os demais (semestres anteriores/repercurso) so quando o total deles muda.
const verificarNotas = comGuard("notas", async () => {
    log("info", "verificarNotas: inicio");
    const cache   = getCache();
    const agoraTs = Math.floor(agora().toSeconds());
    const ultima  = cache._ultimaNotas || null;
    const { cursos, ids } = await cursosDoSemestre();

    const alvo = new Map(cursos.map(c => [c.id, c.fullname]));
    let totais = [];
    try { totais = await retry(() => buscarNotasGerais()); }
    catch (e) { log("aviso", `verificarNotas: totais indisponiveis (${e.message}), conferindo so o semestre.`); }
    for (const t of totais) {
        const k = `notatotal_${t.courseid}`;
        if (!ids.has(t.courseid) && k in cache && cache[k] !== t.rawgrade)
            alvo.set(t.courseid, await buscarNomeCurso(t.courseid).catch(() => `Curso ${t.courseid}`));
    }

    const avisos = [];
    for (const [courseid, nomeCurso] of alvo) {
        let itens;
        try { itens = await retry(() => buscarNotasCurso(courseid)); }
        catch (e) { log("aviso", `verificarNotas: falha em "${nomeCurso}": ${e.message}`); continue; }

        const chaveBase = `notabase_${courseid}`;
        const temBase   = !!cache[chaveBase];
        for (const it of itens) {
            if (it.itemtype !== "mod" || it.graderaw == null || it.gradeishidden) continue;
            const chave = `nota_${it.id}`;
            const antes = cache[chave];
            const mudou = !antes || antes.g !== it.graderaw || antes.d !== it.gradedategraded;
            if (!mudou) continue;

            // Sem base ainda: so avisa se a correcao e posterior a ultima verificacao (evita avisar notas antigas)
            const avisar = temBase ? true : (ultima && it.gradedategraded > ultima);
            if (avisar) avisos.push({ nomeCurso, it, notaAnterior: antes?.g ?? null });
            else cache[chave] = { g: it.graderaw, d: it.gradedategraded };
        }
        cache[chaveBase] = true;
    }

    for (const t of totais) cache[`notatotal_${t.courseid}`] = t.rawgrade;

    if (avisos.length) {
        const blocos = [], feedbacksLongos = [];
        for (const { nomeCurso, it, notaAnterior } of avisos) {
            const { corretor, feedback } = await detalhesCorrecao(it);
            const disc   = normalizarNomeDisciplina(nomeCurso);
            const nome   = it.itemname || "atividade";
            const mudou  = notaAnterior != null && notaAnterior !== it.graderaw;
            const titulo = corretor
                ? `${corretor} ${mudou ? "alterou a nota da" : "corrigiu"} sua \`${nome}\` de ${disc}`
                : `${mudou ? "Nota alterada" : "Nota lancada"}: \`${nome}\` de ${disc}`;
            blocos.push(
                `*${titulo}*\n` +
                `Nota    ${fmtNota(it)}` +
                (mudou ? `\n(antes: ${Number(notaAnterior).toFixed(2)})` : "") +
                (feedback && feedback.length <= LIMITE_TEXTO ? `\n\nFeedback:\n\`\`\`\n${feedback}\n\`\`\`` : "") +
                (feedback.length > LIMITE_TEXTO ? `\n\nFeedback longo: segue em arquivo` : "")
            );
            if (feedback.length > LIMITE_TEXTO) feedbacksLongos.push({ nome, feedback });
            log("ok", `Nota: "${nome}" (${disc}) ${fmtNota(it)}${corretor ? ` por ${corretor}` : ""}`);
        }
        await wa(ADMIN, blocos.join("\n\n━━━━━━━━━━\n\n"));
        for (const { nome, feedback } of feedbacksLongos)
            await enviarTextoOuArquivo([ADMIN], `Feedback de \`${nome}\``, feedback, "feedback.txt");
        for (const { it } of avisos) cache[`nota_${it.id}`] = { g: it.graderaw, d: it.gradedategraded };
    }

    cache._ultimaNotas = agoraTs;
    salvarCache();
    log("info", `verificarNotas: ${avisos.length > 0 ? `${avisos.length} nota(s) nova(s)` : "nenhuma nova"}`);
});

module.exports = {
    verificarNotas,
    verificarLembretes, verificarAvisos, verificarVencimentos,
    verificarForuns, verificarAulasHoje,
    // Exportados para os testes (testes/unitarios.test.js)
    montarMsgVencimentos, nomeDoEvento, diasAte,
};
