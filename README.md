# Moodle WhatsBot

Bot que monitora o Moodle e envia notificacoes automaticas via WhatsApp: atividades novas de qualquer tipo, prazos do dia, prazos estendidos, avisos dos professores, links e gravacoes de aula, aulas ao vivo e notas, sem precisar acessar a plataforma.

Feito para turmas de EaD que querem receber tudo direto no WhatsApp (grupo da turma e/ou contatos), sem depender de email ou ficar checando o Moodle. Projeto Integrador do curso de ADS (UESB/UAB).

## Funcionalidades

**Para a turma** (enviado aos `DESTINOS`):

- **Atividades novas de qualquer tipo**: tarefas (com descricao e anexos), questionarios, foruns, licoes, workshops, arquivos, pastas, paginas, H5P etc.
- **Links e gravacoes novos**: links do EduPlay, Kahoot, Wordwall e similares adicionados nas disciplinas
- **Avisos dos professores**: posts nos foruns de avisos, com autor e texto
- **Vence hoje**: tarefas, questionarios e demais atividades com prazo no dia. Se o prazo foi estendido, a mensagem diz que ja avisou antes e qual era o prazo anterior
- **Lembretes no meio do prazo**: alem do lancamento e do "vence hoje", de 0 a 3 lembretes conforme a duracao (ex.: prazo de 1 mes -> "faltam 2 semanas"; prazo de 2 meses -> 6 e 3 semanas; menos de 4 dias -> nenhum)
- **Atualizacoes**: prazo estendido/alterado e arquivos novos em atividades ja avisadas
- **Foruns com prazo hoje**
- **Aulas ao vivo**: avisa antes das aulas com o link da sala (Mconf/ConferenciaWeb), juntando eventos duplicados da mesma sala
- **Mensagens unificadas**: varios itens do mesmo tipo saem em uma mensagem so ("3 NOVOS LINKS", "2 ATIVIDADES VENCEM HOJE"...)
- **Textos longos em arquivo**: descricoes, avisos e feedbacks com mais de 1000 caracteres vao como `descrição.txt` (ou `aviso.txt`/`feedback.txt`) em vez de uma mensagem gigante
- **Legendas EduPlay**: envia a legenda em texto ao receber link do EduPlay
- **Comando /disciplinas**: lista as disciplinas do semestre atual

**So para o admin** (`ADMIN_NUMERO`):

- **Notas**: de hora em hora, avisa nota nova ou alterada de qualquer atividade, com o nome de quem corrigiu (tarefas) e o feedback, se houver
- **Erros e falhas** do bot

**Robustez**:

- **Credenciais verificadas antes do WhatsApp**: se `MOODLE_USER`/`MOODLE_PASS` estiverem vazios ou errados, avisa e encerra antes de mostrar o QR code
- **Deteccao por ID**: atividades, modulos e links novos sao detectados pelo ID, nao por data. Nada se perde se o professor criar uma atividade oculta e liberar dias depois, ou se so editar um link antigo
- **Recupera o que perdeu**: ao religar depois de um periodo desligado, avisa o que apareceu nesse tempo e os avisos do dia que ja deveriam ter saido
- **So o semestre atual**: disciplinas de semestres anteriores (repercurso) sao ignoradas; cursos permanentes sem semestre no nome (ex.: Informes da Coordenacao, ATPA) entram automaticamente
- **Independe do seu progresso**: atividades que voce ja entregou continuam sendo avisadas para a turma
- **Auto-login**: token do Moodle gerado e renovado automaticamente
- **Telegram como fallback**: opcional, envia por la se o WhatsApp falhar

## Horarios das verificacoes

| Horario                                   | Verificacao                                              |
| ----------------------------------------- | -------------------------------------------------------- |
| Ao iniciar                                | Conteudo novo, notas e avisos do dia que ja passaram     |
| 06h, 09h, 12h, 15h, 18h, 21h              | Tarefas novas (:00), modulos e links novos (:05), avisos (:10) |
| 10:00                                     | Atualizacoes (prazos estendidos, novos arquivos)         |
| 12:00                                     | Atividades que vencem hoje e lembretes de prazo          |
| 14:00                                     | Foruns com prazo hoje                                    |
| 18:00, 19:00, 20:00                       | Aulas ao vivo do dia                                     |
| 07:30 ate 23:30, de hora em hora          | Notas (so admin)                                         |

A agenda fica em `comandos/moodle/rotina.js`.

## Como os dados sao buscados

O bot usa a mesma API REST do app oficial Moodle Mobile (login em `/login/token.php`, servico `moodle_mobile_app`). Principais funcoes:

| Funcao da API                              | Uso                                                              |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `core_course_get_contents`                 | Todos os modulos de cada disciplina (novos itens, links, prazos) |
| `mod_assign_get_assignments` (`courseids`) | Tarefas com descricao e anexos (filtrado pelo semestre, ~10x menor) |
| `core_calendar_get_calendar_day_view`      | Prazos do dia de qualquer tipo de atividade e aulas ao vivo      |
| `mod_forum_get_forums_by_courses` + `mod_forum_get_forum_discussions` | Avisos dos professores       |
| `gradereport_overview_get_course_grades`   | Total de notas de todos os cursos (1 requisicao, detecta mudanca)|
| `gradereport_user_get_grade_items`         | Notas por atividade                                              |
| `mod_assign_get_submission_status` + `core_user_get_users_by_field` | Quem corrigiu e feedback   |
| `mod_lti_get_tool_launch_data`             | Link real da sala de aula (Mconf)                                |

O cache (`moodle/cache.json`) guarda o que ja existe e o que ja foi avisado. Na primeira vez que o bot ve uma disciplina, ele registra tudo em silencio e so avisa o que surgir depois.

## Tecnologias

- **Node.js** (v18+)
- **[Baileys](https://github.com/WhiskeySockets/Baileys)**: conexao com o WhatsApp via protocolo Web (sem API oficial, sem custos)
- **Luxon**: datas e horarios (fuso America/Sao_Paulo)

Sem banco de dados, sem servidor web. O bot roda como um processo Node.js simples.

## Instalacao

```bash
git clone https://github.com/mrccrqr/moodle-whatsbot.git
cd moodle-whatsbot
npm install
```

### Configuracao

```bash
# Cria a pasta de dados e o arquivo de configuracao
mkdir -p moodle
cp .env.example moodle/.env
```

Edite `moodle/.env` com suas credenciais. Apenas 3 campos sao obrigatorios:

```env
MOODLE_USER=seu_usuario
MOODLE_PASS=sua_senha
ADMIN_NUMERO=77991234567
```

O numero e so DDD + numero. Com ou sem o nono digito: o bot pergunta ao WhatsApp qual e o ID real da conta
(contas antigas continuam registradas sem o 9). `ADMIN_JID` (formato antigo) ainda funciona.

### Quem recebe as notificacoes (grupos e pessoas)

Tudo e feito **no privado do bot**, so pelo admin (mensagens de outras pessoas sao ignoradas). O bot grava
os destinos em `DESTINOS` no `moodle/.env` sozinho; nao precisa descobrir ID de grupo. Sao 3 comandos:

**`/add-grupo`**: adicione o numero do bot ao grupo (ele avisa no privado quando entra) e mande `/add-grupo`:

```
Bot: GRUPOS EM QUE ESTOU
     1. MOODLE uesb  (ativo)
     2. UESB - Academicos.Digital
Bot: Quais desses vc quer eu envie notificações do Moodle?
Bot: Me responda com a opção desejada
Voce: 2
Bot: Notificações do Moodle ativadas no grupo UESB - Academicos.Digital
```

**`/add-pessoa`**: o bot pede o contato; envie o **cartao de contato** da pessoa (clipe > Contato) ou digite o
numero com DDD. O cartao traz o numero exato do WhatsApp (sem erro de digitacao nem problema com o nono digito)
e da para enviar varios de uma vez. Quem e adicionado recebe uma mensagem de boas-vindas e pode responder
**SAIR** a qualquer momento (o admin e avisado). Mandar mensagens para quem nao pediu e o principal motivo de
banimento de numeros de bot no WhatsApp.

**`/remover`**: lista grupos e pessoas que recebem e pergunta qual remover.

Detalhes:

- O bot espera a resposta por 5 minutos. Se nao entender (ex.: "o da turma"), pergunta de novo.
  Da para responder varios numeros de uma vez ("1 e 3"). `/cancelar` encerra a espera.
- Atalhos sem pergunta: `/add-grupo 2`, `/add-pessoa 77991234567`, `/remover 3`.
- Aceita variacoes: `/add-grupo`, `/addgrupo`, `/add grupo` (maiusculas ou minusculas).
- Cartao de contato enviado **sem** `/add-pessoa` antes nao adiciona ninguem (evita adicionar alguem por
  engano, ex. um contato encaminhado ao bot).
- Nada e enviado nos grupos por causa desses comandos.

| Comando (no privado do bot) | O que faz |
|---|---|
| `/add-grupo` | Mostra os grupos do bot e pergunta qual ativar |
| `/add-pessoa` | Pede o contato (ou numero) da pessoa e adiciona |
| `/remover` | Mostra quem recebe e pergunta qual remover |
| `/cancelar` | Encerra uma pergunta em andamento |
| `/disciplinas` | Disciplinas do semestre atual |

Sem nenhum destino, as notificacoes vao para o admin.

Trocar `MOODLE_USER` no `.env` descarta automaticamente o token da conta anterior.

O token do Moodle e gerado automaticamente no primeiro login. O semestre e detectado automaticamente pelo nome dos cursos (padrao `(AAAA.S)`), ou pela categoria em `MOODLE_PARENT_CAT_ID`.

### Personalizacao (opcional)

Edite `comandos/moodle/disciplinas.json` para:

- **nomesCurtos**: abreviar nomes longos nas notificacoes
- **linksFixos**: links de salas de aula que nao mudam
- **disciplinasIgnoradas**: disciplinas que nao devem gerar notificacao de aula
- **aulasExtras**: aulas que nao aparecem no calendario do Moodle (ignoradas se o calendario ja tiver aula da disciplina no dia)

### Executar

```bash
npm start
```

O bot primeiro confere o login no Moodle. Se estiver tudo certo, mostra o QR code: escaneie com o WhatsApp (so na primeira vez).

## Testes

```bash
npm test          # testes rapidos e offline (lembretes, mensagens, formatacao)
npm run simular   # simula os ultimos 7 dias com a agenda real e dados reais do Moodle
npm run whatsapp  # diagnostico do WhatsApp: conta conectada, numero do admin (com/sem 9) e grupos com nome e ID
```

Para parear o bot por codigo em vez de QR: `npm run whatsapp -- parear 77991234567` (numero da conta do bot).
Para testar o envio ao admin: `npm run whatsapp -- enviar`. Pare o `npm start` antes.

O `npm run simular` usa a conta do `moodle/.env`, faz so leituras no Moodle, **nao envia nada** no WhatsApp e
restaura o cache ao final. O resultado (todas as mensagens que teriam sido enviadas, dia a dia) fica em
`testes/saida-simulacao.txt`. Use `npm run simular -- 14` para 14 dias.

## Servidor (VPS)

Todos os horarios usam o fuso America/Sao_Paulo, independente do fuso do servidor (12:00 do bot = 12:00 de
Brasilia, mesmo numa VPS na Europa). Para migrar: copie `moodle/` (`.env` e `cache.json`) e a pasta `auth/`
(sessao do WhatsApp, evita escanear o QR de novo; mantenha privada) e rode com um gerenciador de processo
(`pm2` ou `systemd`). Nunca rode duas instancias com a mesma pasta `auth/` ao mesmo tempo.

## Proximos passos

Ver [ROADMAP.md](ROADMAP.md) (aula ao vivo, aulas quinzenais automaticas, pontos ainda manuais) e
[docs/LLM.md](docs/LLM.md) (notas para o assistente com IA).

## Estrutura

```
moodle-whatsbot/
  index.js                  # Verifica o Moodle, conecta ao WhatsApp e roteia comandos
  comandos/
    moodle/
      index.js              # Inicializacao do monitor do Moodle
      rotina.js             # Agenda de verificacoes (horarios)
      verificacoes.js       # Verificacoes: novas, modulos, avisos, vencimentos, aulas, notas...
      lembretes.js          # Regra dos lembretes intermediarios de prazo
      api.js                # Chamadas a API do Moodle
      auth.js               # Login e renovacao de token
      config.js             # Variaveis de ambiente
      agendamento.js        # Agendador diario
      lti.js                # Resolucao de links LTI/Mconf
      envios.js             # Montagem de mensagens de atividades
      notificacoes.js       # Envio WhatsApp + Telegram
      ...                   # cache, formatacao, http, utils
    disciplinas.js          # Comando /disciplinas
    destinos.js             # /add-grupo, /add-pessoa, /remover, SAIR (quem recebe as notificacoes)
    eduplay.js              # Legendas do EduPlay
  testes/                   # npm test (unitarios) e npm run simular
  docs/LLM.md               # Notas para o futuro assistente com IA
  utils/
    verificarMoodle.js      # Teste das credenciais antes de iniciar o WhatsApp
    telefone.js / jid.js    # Numeros (DDD + numero, nono digito) e resolucao do ID real no WhatsApp
    wa.js                   # Wrapper de envio WhatsApp
    autenticacao.js         # Autenticacao Baileys
  moodle/                   # Dados em runtime (gitignored)
    .env                    # Suas credenciais
    cache.json              # O que ja existe/ja foi avisado
    logs.txt                # Log do bot
```

## Licenca

ISC
