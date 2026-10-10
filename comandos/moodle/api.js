'use strict';

const { estado, PARENT_CAT_ID } = require("./config");
const { log }                   = require("./utils");
const { postForm }              = require("./http");
const { retry, obterSiteInfo }  = require("./auth");

// Chamada generica a API do Moodle (Web Services)
const moodle = payload => postForm(
    "/webservice/rest/server.php?moodlewsrestformat=json",
    { ...payload, wstoken: estado.wsToken }
);

// Valida resposta da API e lanca erro padronizado
function validar(d, funcao, campo) {
    if (campo) {
        if (!d[campo]) {
            if (d?.exception || d?.errorcode)
                throw Object.assign(new Error(d.message || `Erro em ${funcao}`), { moodleError: d });
            throw new Error(`Resposta invalida de ${funcao}`);
        }
        return d[campo];
    }
    if (!Array.isArray(d)) {
        if (d?.exception || d?.errorcode)
            throw Object.assign(new Error(d.message || `Erro em ${funcao}`), { moodleError: d });
        throw new Error(`Resposta invalida de ${funcao}`);
    }
    return d;
}

async function buscarAtividades() {
    const d = await moodle({ wsfunction: "mod_assign_get_assignments" });
    if (d.exception || d.errorcode)
        throw Object.assign(new Error(d.message || "Erro em mod_assign_get_assignments"), { moodleError: d });
    return d;
}

async function buscarCategorias(parentId) {
    const d = await moodle({
        wsfunction: "core_course_get_categories",
        "criteria[0][key]": "parent",
        "criteria[0][value]": parentId,
    });
    return validar(d, "core_course_get_categories");
}

async function buscarCursosPorCategoria(categoryId) {
    const d = await moodle({ wsfunction: "core_course_get_courses_by_field", field: "category", value: categoryId });
    return validar(d, "core_course_get_courses_by_field", "courses");
}

// Detecta semestre atual automaticamente:
// 1. Se PARENT_CAT_ID configurado: busca por hierarquia de categorias
// 2. Fallback: detecta padrao (YYYY.S) no nome dos cursos do usuario
// 3. Ultimo recurso: cursos com startdate mais recente
async function buscarCursos() {
    if (PARENT_CAT_ID) {
        try {
            const cats      = await retry(() => buscarCategorias(PARENT_CAT_ID));
            const semestres = cats.filter(c => c.parent === PARENT_CAT_ID);
            const subcats   = cats.filter(c => c.parent !== PARENT_CAT_ID);

            const semAtual = semestres
                .map(s => ({
                    ...s,
                    totalCursos: s.coursecount + subcats
                        .filter(sc => sc.parent === s.id)
                        .reduce((sum, sc) => sum + sc.coursecount, 0),
                }))
                .filter(s => s.totalCursos > 0)
                .sort((a, b) => b.sortorder - a.sortorder)[0];

            if (semAtual) {
                const catIds = [semAtual.id, ...subcats.filter(sc => sc.parent === semAtual.id).map(sc => sc.id)];
                const cursos = (await Promise.all(catIds.map(id => retry(() => buscarCursosPorCategoria(id))))).flat();
                if (cursos.length > 0) {
                    log("info", `Semestre detectado via categorias: "${semAtual.name}" (${cursos.length} curso(s))`);
                    return cursos;
                }
                log("aviso", `Categoria "${semAtual.name}" sem cursos — usando fallback.`);
            }
        } catch (e) {
            log("aviso", `Deteccao por categorias falhou: ${e.message}. Usando fallback.`);
        }
    }

    // Fallback: busca todos os cursos do usuario
    if (!estado.userId) await retry(() => obterSiteInfo());
    const d = await retry(async () => {
        const res = await moodle({ wsfunction: "core_enrol_get_users_courses", userid: estado.userId });
        return validar(res, "core_enrol_get_users_courses");
    });

    // Tenta agrupar por padrao (YYYY.S) no nome
    const semestresMap = new Map();
    for (const c of d) {
        const m = c.fullname.match(/\((\d{4})\.(\d)\)/);
        if (m) {
            const k = parseInt(m[1]) * 10 + parseInt(m[2]);
            semestresMap.set(k, [...(semestresMap.get(k) || []), c]);
        }
    }
    if (semestresMap.size > 0) {
        const recente = Math.max(...semestresMap.keys());
        log("info", `Semestre detectado via nome: ${Math.floor(recente / 10)}.${recente % 10}`);
        return semestresMap.get(recente);
    }

    // Ultimo recurso: cursos mais recentes por startdate
    log("aviso", "Padrao (YYYY.S) nao encontrado, usando fallback por startdate.");
    const sorted = d.filter(c => c.startdate > 0).sort((a, b) => b.startdate - a.startdate);
    const top5   = sorted.slice(0, 5);
    if (!top5.length) return d;
    const ref = top5[0].startdate;
    return top5.filter(c => ref - c.startdate <= 60 * 86400);
}

async function buscarConteudo(courseid) {
    const d = await moodle({
        wsfunction:             "core_course_get_contents",
        courseid,
        "options[0][name]":     "includestealthmodules",
        "options[0][value]":    1,
        "options[1][name]":     "modname",
        "options[1][value]":    "url",
        moodlewssettingfilter:  true,
        moodlewssettingfileurl: true,
        moodlewssettinglang:    "pt_br",
    });
    return validar(d, `core_course_get_contents(${courseid})`);
}

// Todos os modulos do curso, de qualquer tipo (quiz, forum, lesson, workshop, etc.)
async function buscarModulos(courseid) {
    const d = await moodle({
        wsfunction:             "core_course_get_contents",
        courseid,
        "options[0][name]":     "includestealthmodules",
        "options[0][value]":    1,
        moodlewssettingfilter:  true,
        moodlewssettingfileurl: true,
        moodlewssettinglang:    "pt_br",
    });
    return validar(d, `core_course_get_contents(${courseid})`);
}

// Foruns de avisos (type=news) dos cursos informados
async function buscarForunsAvisos(courseIds) {
    const payload = { wsfunction: "mod_forum_get_forums_by_courses" };
    courseIds.forEach((id, i) => { payload[`courseids[${i}]`] = id; });
    const d = await moodle(payload);
    return validar(d, 'mod_forum_get_forums_by_courses').filter(f => f.type === 'news');
}

// Discussoes mais recentes de um forum
async function buscarDiscussoes(forumid) {
    const d = await moodle({ wsfunction: 'mod_forum_get_forum_discussions', forumid, sortorder: -1, perpage: 10 });
    return validar(d, 'mod_forum_get_forum_discussions', 'discussions');
}

async function buscarAulasCalendario(ano, mes, dia) {
    const d = await moodle({
        wsfunction:             "core_calendar_get_calendar_day_view",
        year: ano, month: mes, day: dia,
        moodlewssettingfilter:  true,
        moodlewssettingfileurl: true,
        moodlewssettinglang:    "pt_br",
    });
    if (!d.events) throw new Error("Resposta invalida de core_calendar_get_calendar_day_view");
    return d.events;
}

module.exports = { moodle, buscarAtividades, buscarCategorias, buscarCursosPorCategoria, buscarCursos, buscarConteudo, buscarModulos, buscarForunsAvisos, buscarDiscussoes, buscarAulasCalendario };
