/**
 * Человеческая страница контракта `GET /v1/docs` — самодостаточный HTML без
 * внешних CDN (агент часто работает офлайн, поэтому Swagger UI из сети не
 * подходит). Рендерится из той же таблицы операций, что и `/v1/openapi.json`,
 * поэтому страница не может разойтись со спекой.
 *
 * Стиль — строки и глифы `docs/design/ui/STYLE.md`: без рамок и боксов,
 * моноширинный путь, цветовой код метода, dim-разделители `·`.
 */
import { OPERATIONS, type SpecOperation } from "./operations";

const CSS = `:root{color-scheme:light dark;--fg:#1c1f24;--dim:#6b7280;--bg:#fbfbfd;--card:#fff;--bd:#e6e8ec;--ok:#177245;--warn:#9a6400;--err:#b4232b;--post:#7a3ecb;--del:#b4232b}
@media(prefers-color-scheme:dark){:root{--fg:#e6e8ec;--dim:#9aa3af;--bg:#14161a;--card:#191c21;--bd:#2a2f37;--ok:#4cc38a;--warn:#e2b341;--err:#f27272;--post:#c39bff;--del:#f27272}}
*{box-sizing:border-box}
body{margin:0;padding:32px 28px 64px;background:var(--bg);color:var(--fg);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:980px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:34px 0 10px;letter-spacing:.01em}
p{margin:8px 0}a{color:inherit}
code,.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
.dim{color:var(--dim)}.small{font-size:13px}
pre{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:12px 14px;overflow-x:auto;margin:10px 0}
.op{display:grid;grid-template-columns:74px 1fr;gap:0 12px;padding:11px 0;border-bottom:1px solid var(--bd)}
.op:last-child{border-bottom:0}
.m{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.06em;text-align:center;border-radius:5px;padding:2px 0;align-self:start;margin-top:2px}
.m.get{color:var(--ok);background:color-mix(in oklab,var(--ok) 12%,transparent)}
.m.post{color:var(--post);background:color-mix(in oklab,var(--post) 12%,transparent)}
.m.delete{color:var(--del);background:color-mix(in oklab,var(--del) 12%,transparent)}
.path{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13.5px}
.summ{color:var(--fg);margin:2px 0 3px}.desc{color:var(--dim);font-size:13.5px}
.resp{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--dim);margin-top:4px}
.resp b{color:var(--warn);font-weight:600}
.badge{display:inline-block;font-size:11px;color:var(--dim);border:1px solid var(--bd);border-radius:999px;padding:1px 8px;margin-left:8px;vertical-align:middle}
ul{margin:8px 0;padding-left:20px}li{margin:3px 0}
.kv{display:grid;grid-template-columns:220px 1fr;gap:2px 14px;font-size:13.5px;margin:8px 0}
.kv div:nth-child(odd){font-family:ui-monospace,Menlo,Consolas,monospace;color:var(--dim);font-size:12.5px}
.copy{float:right;font:inherit;font-size:12px;color:var(--dim);background:none;border:1px solid var(--bd);border-radius:6px;padding:2px 8px;cursor:pointer}
.copy:hover{color:var(--fg)}`;

/** Экранирование для HTML-текста (описания берутся из кода, но правило дешёвое). */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Метод → короткая подпись (спека знает только верхний регистр). */
const METHOD_LABEL: Record<string, string> = { get: "GET", post: "POST", delete: "DELETE" };

/** Коды ответов строкой: `200`, `404`, `default`. */
function responseLine(op: { responses: Record<string, { description: string }> }): string {
  return Object.entries(op.responses)
    .map(([status, r]) => {
      const code = status === "default" ? "err" : status;
      return `<b>${code}</b> ${esc(r.description)}`;
    })
    .join(" · ");
}

/** Вход рендера страницы. */
export interface DocsPageOptions {
  /** Версия рантайма. */
  version: string;
  /** Требуется ли bearer-токен (влияет на текст про auth). */
  authRequired: boolean;
  /** Операции контракта (по умолчанию — из `operations.ts`). */
  operations?: SpecOperation[];
}

/**
 * Рендерит страницу контракта. Никаких внешних ресурсов: открыл — работает
 * офлайн, без CDN-запросов и без выполнения чужого JS.
 */
export function renderDocsPage(options: DocsPageOptions): string {
  const ops = options.operations ?? OPERATIONS;
  const sections = ["ops", "sessions", "tasks", "events"]
    .map((tag) => {
      const items = ops.filter((op) => op.tag === tag);
      if (items.length === 0) return "";
      return [
        `<h2 id="${tag}">${esc(tag)}</h2>`,
        ...items.map((op) => {
          const codes = responseLine(op);
          return [
            `<div class="op">`,
            `<span class="m ${op.method}">${METHOD_LABEL[op.method] ?? op.method}</span>`,
            `<div><div class="path">${esc(op.path)}${op.open ? '<span class="badge">no auth</span>' : ""}</div>`,
            `<div class="summ">${esc(op.summary)}</div>`,
            op.description ? `<div class="desc">${esc(op.description)}</div>` : "",
            `<div class="resp">${codes}</div>`,
            `</div></div>`,
          ].join("");
        }),
      ].join("");
    })
    .join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MMA Agent Service API v1</title>
<style>${CSS}</style>
</head><body><main>
<h1>MMA Agent Service API <span class="dim">v1</span></h1>
<p class="dim small">mma ${esc(options.version)} · HTTP-контракт <code>mma serve</code> для внешних систем (боты, бэкенды, cron) — те же агент, сессии и тулы, что в CLI/REPL/<code>mma web</code>.</p>
<p class="small">Машинная спецификация: <a href="/v1/openapi.json"><code>/v1/openapi.json</code></a> (OpenAPI 3.1 — Swagger UI, Redoc, Postman, Insomnia, генерация клиента).
Полный гайд интегратора и изоляция по процессам — в репозитории: <code>docs/serve-mode.md</code>.</p>
${renderQuickstart(options)}
${renderContractNotes()}
${sections}
</main></body></html>`;
}

/** Блок «с чего начать»: готовые cURL-команды. */
function renderQuickstart(options: DocsPageOptions): string {
  const host = "{{base_url}}";
  const auth = options.authRequired ? `\n  -H 'Authorization: Bearer $MMA_SERVICE_TOKEN' \\` : "";
  return `<h2 id="quickstart">Quickstart</h2>
<pre><button class="copy" data-copy>copy</button><code># 1 · поднять сервис
mma serve                      # 127.0.0.1:7331 (конфиг service.port)
mma serve --port 8080 --host 0.0.0.0 --token "$SECRET"

# 2 · создать сессию
curl -s -XPOST ${host}/v1/sessions \\${auth}
  -H 'Content-Type: application/json' \\
  -d '{"externalRef":"chat:42","name":"support"}'
# → {"id":"ses_…","externalRef":"chat:42","status":"idle", …}

# 3 · задача и результат
curl -s -XPOST ${host}/v1/sessions/<id>/tasks \\${auth}
  -H 'Content-Type: application/json' \\
  -d '{"input":"Суммируй бэклог поддержки за сегодня","mode":"job","wait":true}'
# → {"jobId":"job_…","status":"succeeded","result":{"text":"…"},"usage":{…}}

# 4 · следить за ходом вживую (SSE)
curl -N ${host}/v1/sessions/<id>/events${options.authRequired ? " \\\n  -H 'Authorization: Bearer $MMA_SERVICE_TOKEN'" : ""}
# event: text.delta · data: {"v":1,"seq":7,"ts":…,"type":"text.delta","sessionId":"ses_…","data":{…}}</code></pre>
<p class="small dim">$MMA_SERVICE_TOKEN обязателен только если задан <code>service.token</code>/<code>MMA_SERVICE_TOKEN</code> — тогда его нужно слать во всех <code>/v1/*</code>, кроме проб и discovery.</p>
<script>
document.querySelectorAll('[data-copy]').forEach(function (b) {
  b.addEventListener('click', function () {
    var pre = b.closest('pre');
    navigator.clipboard.writeText(pre.innerText.replace(/^copy\\n/, '')).then(function () {
      b.textContent = 'copied'; setTimeout(function () { b.textContent = 'copy'; }, 1200);
    });
  });
});
</script>`;
}

/** Четыре правила контракта, без которых интегратор спотыкается. */
function renderContractNotes(): string {
  return `<h2 id="contract">Как устроен контракт</h2>
<ul class="small">
<li><b>Задача = ход над сессией.</b> Не «параллельный воркер», а один ход агента: <code>job</code> — автономная (вопросы запрещены, работает строгий <code>toolAllowlist</code>: теги и <code>alwaysOn</code> его не обходят), <code>interactive</code> — вопросы через SSE + <code>POST /v1/tasks/{jobId}/answer</code>.</li>
<li><b>Pull — источник правды.</b> <code>GET /v1/tasks/{jobId}</code> отдаёт тот же Job-объект, что и webhook; SSE и колбэки — оптимизации. <code>Idempotency-Key</code> делает сабмит повторяемым (тот же <code>jobId</code>; другое тело → <code>409</code>).</li>
<li><b>Ошибки — RFC 9457.</b> Ветвиться по стабильному <code>type</code>-URI (<code>…/queue-full</code>, <code>…/tool-forbidden</code>, <code>…/output-invalid</code>), а не по тексту <code>detail</code>. Есть <code>is_retriable</code> и <code>retry_after_ms</code>.</li>
<li><b>Изоляция — процесс.</b> 1 тенант = 1 процесс со своим <code>MMA_CONFIG_DIR</code> и workspace; не выставляйте рантайм в интернет, держите свой control plane (он же терминирует end-user auth).</li>
</ul>`;
}
