/** A small launcher for an external page. The iframe owns the chat and keeps its state while hidden. */
export const skillWidgetScript = /* javascript */ `(() => {
  const script = document.currentScript;
  const token = script?.dataset.skillShare;
  if (!script?.src || !/^ose_[A-Z2-7]{26,76}$/.test(token ?? '')) return;
  const url = new URL('chat', script.src);
  url.hash = token;
  const chinese = navigator.language.toLowerCase().startsWith('zh');
  const label = chinese ? '智能助手' : 'Chat assistant';
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = \`
    :host{position:fixed;z-index:2147483000;right:20px;bottom:20px;font:14px system-ui,sans-serif;color:#10213a}
    button{font:inherit;cursor:pointer;border:0}
    .launcher{padding:12px 18px;background:#156cfd;color:#fff;border-radius:999px;box-shadow:0 6px 20px #10213a26}
    section{position:absolute;right:0;bottom:56px;width:min(420px,calc(100vw - 40px));height:min(660px,calc(100dvh - 92px));display:flex;flex-direction:column;background:#fff;border:1px solid #d4dfed;border-radius:14px;box-shadow:0 16px 48px #10213a26;overflow:hidden}
    section[hidden]{display:none}
    header{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#f3f7fc;border-bottom:1px solid #d4dfed}
    header button{min-width:32px;min-height:32px;font-size:20px;color:inherit;background:transparent;border-radius:6px}
    button:focus-visible{outline:2px solid #156cfd;outline-offset:2px}
    iframe{border:0;width:100%;min-height:0;flex:1}
    @media(max-width:480px){:host{right:12px;bottom:12px}section{width:calc(100vw - 24px);height:calc(100dvh - 80px)}}
  \`;
  const launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'launcher';
  launcher.textContent = label;
  launcher.setAttribute('aria-controls', 'skill-chat');
  launcher.setAttribute('aria-expanded', 'false');
  const panel = document.createElement('section');
  panel.id = 'skill-chat';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', label);
  const header = document.createElement('header');
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', chinese ? '收起聊天' : 'Minimize chat');
  header.append(label, close);
  panel.append(header);
  const frame = document.createElement('iframe');
  frame.title = label;
  frame.referrerPolicy = 'no-referrer';
  const setOpen = (open) => {
    if (open && !frame.isConnected) {
      frame.src = url.href;
      panel.append(frame);
    }
    panel.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
    (open ? close : launcher).focus();
  };
  launcher.addEventListener('click', () => setOpen(panel.hidden));
  close.addEventListener('click', () => setOpen(false));
  panel.addEventListener('keydown', (event) => { if (event.key === 'Escape') setOpen(false); });
  shadow.append(style, panel, launcher);
  document.body.append(host);
})();`
