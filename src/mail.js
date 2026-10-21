'use strict';

// Outgoing email: confirming an address and resetting a password. Sent over SMTP when SMTP_URL is
// set (smtps://user:pass@host:465 from any provider); without it the message is printed to the log,
// so local runs and tests work, and the last messages are kept in `outbox`.

const FROM = process.env.MAIL_FROM || 'bluepeau.club <hello@bluepeau.club>';

const TEXTS = {
  en: {
    verify: { subject: 'Confirm your email · bluepeau.club', line: 'Confirm this email for your account {name}: it lets you reset your password if you forget it.', button: 'Confirm email', ignore: "If you didn't ask for this, ignore this email." },
    reset: { subject: 'Reset your password · bluepeau.club', line: 'Someone (hopefully you) asked to reset the password of {name}. The link works once, for 30 minutes.', button: 'Set a new password', ignore: "If it wasn't you, ignore this email: your password stays the same." },
  },
  ru: {
    verify: { subject: 'Подтвердите почту · bluepeau.club', line: 'Подтвердите эту почту для аккаунта {name}: с ней можно восстановить пароль, если вы его забудете.', button: 'Подтвердить почту', ignore: 'Если вы этого не запрашивали, просто проигнорируйте письмо.' },
    reset: { subject: 'Сброс пароля · bluepeau.club', line: 'Кто-то (надеемся, вы) запросил сброс пароля для {name}. Ссылка работает один раз, 30 минут.', button: 'Задать новый пароль', ignore: 'Если это были не вы, проигнорируйте письмо: пароль останется прежним.' },
  },
};

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function compose(kind, lang, { name, link }) {
  const tx = (TEXTS[lang] || TEXTS.en)[kind];
  const line = tx.line.replace('{name}', name);
  return {
    subject: tx.subject,
    text: `${line}\n\n${tx.button}: ${link}\n\n${tx.ignore}\n`,
    html: `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#15151a">
<p style="font-size:16px;line-height:1.5">${esc(line)}</p>
<p style="margin:28px 0"><a href="${esc(link)}" style="background:#e5484d;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">${esc(tx.button)}</a></p>
<p style="font-size:13px;color:#666;line-height:1.5">${esc(tx.ignore)}<br><a href="${esc(link)}" style="color:#666;word-break:break-all">${esc(link)}</a></p>
<p style="font-size:12px;color:#999">bluepeau.club</p></div>`,
  };
}

function createMailer({ url = process.env.SMTP_URL, from = FROM } = {}) {
  const transport = url ? require('nodemailer').createTransport(url) : null;
  const outbox = [];
  return {
    enabled: !!transport,
    outbox,
    async send(kind, to, lang, params) {
      const msg = { from, to, ...compose(kind, lang, params) };
      outbox.push(msg);
      if (outbox.length > 20) outbox.shift();
      if (!transport) { console.log(`[mail, not sent: no SMTP_URL] to ${to}: ${msg.subject}\n${msg.text}`); return; }
      await transport.sendMail(msg);
    },
  };
}

module.exports = { createMailer, compose };
