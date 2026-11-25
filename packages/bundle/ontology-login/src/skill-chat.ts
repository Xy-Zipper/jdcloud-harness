/** Public chat uses its own document and a share token held in the URL fragment. */
export const skillChatPage = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Skill</title>
  <link rel="stylesheet" href="./chat.css">
  <script defer src="./chat.js"></script>
</head>
<body>
  <main>
    <header><h1 id="title">Skill</h1></header>
    <section id="messages" aria-live="polite"></section>
    <p id="status" role="status"></p>
    <form id="composer" hidden>
      <label><span id="question-label"></span><textarea id="question" rows="2" maxlength="2000" required></textarea></label>
      <button id="submit" type="submit" disabled></button>
    </form>
  </main>
  <dialog id="sources" aria-labelledby="source-title">
    <div class="dialog-head"><h2 id="source-title"></h2><button type="button" id="close-sources"></button></div>
    <div id="source-list"></div>
  </dialog>
</body>
</html>`

/** Standalone chat adapts the workbench's compact form and source-card treatments. */
export const skillChatStyle = `
  :root{color-scheme:light dark;--bg:#f1f5fb;--card:#fff;--ink:#10213a;--muted:#52667f;--line:#d4dfed;--accent:#156cfd;--tag:#eaf1fa}
  @media(prefers-color-scheme:dark){:root{--bg:#09090f;--card:#111118;--ink:#f5f7ff;--muted:#a7a8b4;--line:#2a2a38;--accent:#9ab6ff;--tag:#171720}}
  *{box-sizing:border-box}
  [hidden]{display:none!important}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
  main{height:100dvh;width:min(100%,880px);margin:auto;padding:clamp(12px,3vw,24px);display:flex;flex-direction:column;gap:12px}
  header{padding-bottom:8px;border-bottom:1px solid var(--line)}
  h1,h2,p{margin:0;overflow-wrap:anywhere}
  h1{font-size:20px;font-weight:600} h2{font-size:16px;font-weight:600}
  #messages{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}
  article{display:grid;gap:8px;margin-bottom:16px}
  .question{justify-self:end;max-width:92%;padding:8px 12px;background:var(--tag);border:1px solid var(--line);border-radius:8px;white-space:pre-wrap}
  .answer,.source{padding:12px;background:var(--card);border:1px solid var(--line);border-radius:8px}
  .answer p,.source p{white-space:pre-wrap;margin-bottom:8px}
  .source + .source{margin-top:8px}
  .source.active{border-color:var(--accent)}
  #status:empty{display:none} #status{color:var(--muted);margin-block:0}
  form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}
  label{display:grid;gap:4px;color:var(--muted);font-size:13px}
  textarea{resize:vertical;max-height:26vh;width:100%;min-height:52px;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);font:inherit}
  button{min-height:32px;border:1px solid var(--line);border-radius:6px;padding:0 10px;background:var(--card);color:var(--ink);cursor:pointer;font:inherit}
  button:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  button:disabled{opacity:.5;cursor:default}
  #submit{background:#156cfd;color:#fff;min-height:36px}
  .tags{display:flex;flex-wrap:wrap;gap:4px}
  .tags button{min-height:24px;color:var(--accent);background:var(--tag);font-size:12px}
  dialog{width:min(100% - 24px,620px);max-height:80dvh;padding:12px;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:8px}
  dialog::backdrop{background:#10213a60}
  .dialog-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
  .source small{color:var(--muted);display:block}
`

/** Keep the public transport and transcript independent from the authenticated shell. */
export const skillChatScript = /* javascript */ `(() => {
  const zh = navigator.language.toLowerCase().startsWith('zh');
  const text = (chinese, english) => zh ? chinese : english;
  document.documentElement.lang = zh ? 'zh-CN' : 'en';
  const get = (id) => document.getElementById(id);
  const title = get('title');
  const form = get('composer');
  const input = get('question');
  const submit = get('submit');
  const status = get('status');
  const messages = get('messages');
  const sources = get('sources');
  const list = get('source-list');
  const token = window.location.hash.slice(1);
  get('question-label').textContent = text('输入问题', 'Enter your question');
  get('source-title').textContent = text('检索结果', 'Search results');
  get('close-sources').textContent = text('关闭', 'Close');
  get('close-sources').addEventListener('click', () => sources.close());
  submit.textContent = text('提问', 'Ask');
  const failure = (code) => code === 401 ? text('分享链接无效或已停用。', 'This share link is inactive.')
    : code === 429 ? text('请求较多，请稍后重试。', 'Too many requests. Try again shortly.')
      : text('知识服务暂不可用，请稍后重试。', 'The knowledge service is unavailable. Try again shortly.');
  const request = async (question) => {
    const asking = question !== undefined;
    const response = await fetch(new URL(asking ? 'embed/chat' : 'embed', document.baseURI), {
      credentials: 'omit',
      headers: { Authorization: 'Bearer ' + token, ...(asking ? { 'Content-Type': 'application/json' } : {}) },
      ...(asking ? { method: 'POST', body: JSON.stringify({ question }) } : {}),
    });
    if (!response.ok) throw new Error(failure(response.status));
    return response.json();
  };
  const add = (parent, tag, content, className) => {
    const child = document.createElement(tag);
    child.textContent = content;
    if (className) child.className = className;
    parent.append(child);
    return child;
  };
  const fragment = (index) => text('片段 ', 'Fragment ') + (index + 1);
  const showSources = (hits, selected) => {
    list.replaceChildren();
    for (const [index, hit] of hits.entries()) {
      const row = add(list, 'article', '', 'source' + (index === selected ? ' active' : ''));
      add(row, 'small', fragment(index) + (hit.page ? text(' · 第 ', ' · Page ') + hit.page + text(' 页', '') : ''));
      add(row, 'h2', hit.fileName);
      add(row, 'p', hit.text);
    }
    sources.showModal();
    list.children[selected]?.scrollIntoView({ block: 'nearest' });
  };
  if (!/^ose_[A-Z2-7]{26,76}$/.test(token)) { status.textContent = failure(401); return; }
  status.textContent = text('正在加载…', 'Loading…');
  request().then((scene) => {
    title.textContent = document.title = scene.name;
    form.hidden = false;
    status.textContent = '';
  }).catch((error) => { status.textContent = error.message || failure(0); });
  let sending = false;
  input.addEventListener('input', () => { submit.disabled = sending || !input.value.trim(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (sending || !question) return;
    sending = input.disabled = submit.disabled = true;
    status.textContent = text('正在检索并生成答案…', 'Finding sources and drafting an answer…');
    try {
      const result = await request(question);
      const turn = add(messages, 'article', '');
      add(turn, 'p', question, 'question');
      const answer = add(turn, 'div', '', 'answer');
      add(answer, 'p', result.answer);
      const tags = add(answer, 'div', '', 'tags');
      for (const [index] of result.sources.entries()) {
        const button = add(tags, 'button', fragment(index));
        button.type = 'button';
        button.addEventListener('click', () => showSources(result.sources, index));
      }
      input.value = status.textContent = '';
      messages.scrollTop = messages.scrollHeight;
    } catch (error) {
      status.textContent = error.message || failure(0);
    } finally {
      sending = input.disabled = false;
      submit.disabled = !input.value.trim();
      input.focus();
    }
  });
})();`
