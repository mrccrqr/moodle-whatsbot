# Assistente com LLM — notas para o futuro

Objetivo: responder no WhatsApp, em linguagem natural e humanizada, qualquer pergunta sobre o Moodle
("qual a programacao dos proximos 3 dias?", "o que falta entregar de BD II?", "quando e a proxima aula de Web?").

Nada disto esta implementado. Sao observacoes coletadas com requisicoes reais (out/2026, contas de ADS e
Pedagogia na UESB) para guiar a arquitetura.

## 1. Arquitetura recomendada: ferramentas, nao RAG, para dados do Moodle

Prazos, aulas, notas e avisos mudam o tempo todo e sao estruturados. Em vez de indexar tudo num banco
vetorial (RAG), o modelo deve **chamar funcoes** que consultam a API do Moodle na hora (tool use /
function calling) e redigir a resposta. RAG fica para conteudo longo e estavel: PDFs de aula,
cronogramas, planos de ensino.

Fluxo de uma pergunta:

```
usuario -> [prompt de sistema + data/hora atual + ferramentas] -> modelo
modelo  -> chama listar_prazos(inicio, fim)  -> bot consulta Moodle -> devolve JSON enxuto
modelo  -> responde em texto natural
```

Ferramentas sugeridas (todas **somente leitura**):

| Ferramenta | Fonte na API | Observacao |
|---|---|---|
| `agenda(inicio, fim)` | `core_calendar_get_calendar_events` (1 requisicao para todas as disciplinas e um intervalo de datas) | Traz prazos de qualquer tipo + aulas. Nao traz URL do modulo; para link use `core_calendar_get_calendar_day_view` (por dia) |
| `pendencias()` | `core_calendar_get_action_events_by_timesort` | So o que **o aluno** ainda nao concluiu (some depois de entregue) — bom para "o que falta eu entregar" |
| `atividade(cmid)` | `mod_assign_get_assignments` / `core_course_get_contents` | Descricao, anexos, datas |
| `avisos(disciplina?, n)` | `mod_forum_get_forums_by_courses` (type=news) + `mod_forum_get_forum_discussions` | Texto completo do professor |
| `notas(disciplina?)` | `gradereport_user_get_grade_items` (+ `mod_assign_get_submission_status` para corretor/feedback) | **So no privado** do dono da conta |
| `disciplinas()` | `buscarCursos()` do bot | Ja resolve semestre e cursos permanentes |
| `buscar_material(pergunta)` | RAG sobre PDFs/paginas | Fase posterior |

As funcoes de `comandos/moodle/api.js` ja fazem quase tudo isso — o assistente deve reutiliza-las.

## 2. Particularidades dos dados (aprendidas na pratica)

- **Fuso:** timestamps sao Unix (UTC). Sempre converter para America/Sao_Paulo antes de mostrar ao modelo
  e informar no prompt a data/hora atual nesse fuso ("hoje e sabado, 10/10/2026, 14:30").
- **Nomes de eventos do calendario** vem com moldes: "X está marcado(a) para esta data", "Término de X",
  "X é devido". Limpar antes (ver `nomeDoEvento` em `verificacoes.js`).
- **Nomes de disciplina** terminam com "(2026.2)"; `normalizarNomeDisciplina` remove. Alunos falam
  "BD II", "Web", "Mobile" — o modelo precisa de uma lista das disciplinas com apelidos para casar.
- **Aulas:** em ADS ficam no calendario (eventos "course"); em Pedagogia nao ha aulas no calendario, so salas
  LTI. Algumas aulas so existem como texto em aviso ("quinzenais, sextas as 20h30") — o LLM e bom em
  extrair isso (ver ROADMAP item 2).
- **Descricoes longas:** existem descricoes de 5+ mil caracteres (ex.: "Hotel Pet"). Mandar para o modelo
  so o necessario (resumo ou trecho), nao a descricao inteira de todas as atividades.
- **Tamanho das respostas da API:** `mod_assign_get_assignments` sem filtro = ~390 KB; com `courseids` do
  semestre = ~38 KB. `core_course_get_contents` = ~42 KB por disciplina. Nunca jogar respostas cruas no
  contexto: montar JSON enxuto (nome, disciplina, prazo formatado, link).
- **Arquivos** do Moodle so baixam com a `accessKey` do usuario (`urlDownload` em `auth.js`).
- **Prazos x conclusao:** o calendario mostra o prazo mesmo depois de entregue; a lista de pendencias nao.
  Para a turma, usar o calendario; para "o que EU falta", pendencias.

## 3. Seguranca

- **Prompt injection:** avisos, descricoes e PDFs sao texto de terceiros que vai entrar no contexto.
  Tratar como dados (delimitar, nunca como instrucao), e o modelo so pode ter ferramentas de leitura.
  Nenhuma ferramenta deve enviar mensagens, mudar configuracao ou acessar outro usuario.
- **Privacidade:** notas e feedback so no privado do dono da conta, nunca no grupo. Em grupo, o assistente
  responde apenas com dados da turma (prazos, aulas, avisos).
- **Credenciais:** token por usuario, nunca senha guardada (ja e o desenho do Projeto Integrador).
- **Custo/abuso:** limite de perguntas por usuario/dia e tamanho maximo de resposta.

## 4. Modelos e custo (precos de out/2026, conferir antes de implementar)

Estimativa por pergunta com ferramentas: ~8 mil tokens de entrada (prompt + definicoes de ferramentas +
resultados) e ~0,5–1 mil de saida, em 2–3 chamadas. Prompt de sistema e ferramentas podem ser cacheados
(leitura de cache custa ~10% da entrada).

| Modelo | Entrada / Saida por 1M tokens | ~Custo por pergunta | ~Perguntas com US$ 20 |
|---|---|---|---|
| Claude Haiku 4.5 | US$ 1 / US$ 5 | US$ 0,01 | ~2.000 |
| Claude Sonnet 5.5 | US$ 2 / US$ 10 | US$ 0,02–0,03 | ~800 |
| Claude Opus 5.5 | US$ 4 / US$ 20 | US$ 0,05 | ~400 |
| GPT-5.4 mini (OpenAI) | US$ 0,75 / US$ 4,50 | US$ 0,008 | ~2.500 |
| Grok 4.1 Fast (xAI) | US$ 0,20 / US$ 0,50 | US$ 0,002 | ~10.000 |
| Gemini Flash (Google) | camada gratis com limite diario | US$ 0 (ate o limite) | — |
| Groq (modelos abertos) | gratis com limites | US$ 0 | — |

Referencia de uso: turma de 30 alunos x 5 perguntas/semana ≈ 650 perguntas/mes.

Observacoes:
- Assinatura Claude Pro/Max (chat) **nao** e chave de API; o bot precisa de creditos da API
  (console da Anthropic), cobrados a parte e pre-pagos.
- Camadas gratis (Gemini, Groq) costumam ter limites por minuto/dia e, no caso do Google, os dados da camada
  gratis podem ser usados para melhorar os produtos — atencao com dados de alunos.
- O que define "humanizado" e acertar a ferramenta certa: modelos pequenos erram mais a escolha e a
  combinacao de ferramentas. Vale testar o mesmo conjunto de perguntas reais em 2–3 modelos antes de escolher.
- Desenho barato e bom: modelo pequeno para perguntas simples + modelo maior so quando a pergunta exige
  combinar varias fontes. Medir antes de complicar.
