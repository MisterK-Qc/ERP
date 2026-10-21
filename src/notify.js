const nodemailer = require('nodemailer');

// Builds the mail transport from the environment. Without SMTP_URL, messages are only logged.
function createTransport() {
  if (process.env.SMTP_URL) return nodemailer.createTransport(process.env.SMTP_URL);
  return {
    async sendMail(message) {
      console.log(`[courriel simulé] À : ${message.to} — ${message.subject}`);
    },
  };
}

function createNotifier(db, { transport = createTransport(), appUrl = process.env.APP_URL || 'http://localhost:3000', from = process.env.MAIL_FROM || 'ArchiDoc <no-reply@archidoc.local>' } = {}) {
  const userById = db.prepare('SELECT id, display_name, email, notify_email FROM users WHERE id = ?');
  const groupMembers = db.prepare(
    `SELECT u.id, u.display_name, u.email, u.notify_email FROM users u
       JOIN user_groups ug ON ug.user_id = u.id WHERE ug.group_id = ?`
  );

  function assignees(step) {
    return step.assignee_type === 'user' ? [userById.get(step.assignee_id)].filter(Boolean) : groupMembers.all(step.assignee_id);
  }

  // Sending never blocks or fails the request that triggered it.
  function send(recipients, subject, lines) {
    const seen = new Set();
    for (const user of recipients) {
      if (!user?.email || !user.notify_email || seen.has(user.id)) continue;
      seen.add(user.id);
      const text = [`Bonjour ${user.display_name},`, '', ...lines, '', '— ArchiDoc'].join('\n');
      Promise.resolve()
        .then(() => transport.sendMail({ from, to: user.email, subject, text }))
        .catch((err) => console.error(`Échec d'envoi du courriel à ${user.email} : ${err.message}`));
    }
  }

  const link = (doc) => `${appUrl}/#/doc/${doc.id}`;
  const dueLine = (step) => (step.due_at ? [`Échéance : ${step.due_at.slice(0, 16).replace('T', ' ')} (UTC)`] : []);

  return {
    stepAssigned(doc, step) {
      send(assignees(step), `[ArchiDoc] À traiter : ${doc.title}`, [
        `Le document « ${doc.title} » attend votre action à l'étape « ${step.name} ».`,
        ...dueLine(step),
        link(doc),
      ]);
    },
    stepOverdue(doc, step) {
      send(assignees(step), `[ArchiDoc] Relance : ${doc.title}`, [
        `L'étape « ${step.name} » du document « ${doc.title} » a dépassé son échéance.`,
        ...dueLine(step),
        link(doc),
      ]);
    },
    approved(doc) {
      send([userById.get(doc.uploaded_by)], `[ArchiDoc] Approuvé : ${doc.title}`, [
        `Votre document « ${doc.title} » a terminé son workflow et est approuvé.`,
        link(doc),
      ]);
    },
    rejected(doc, step, by, comment) {
      send([userById.get(doc.uploaded_by)], `[ArchiDoc] Rejeté : ${doc.title}`, [
        `Votre document « ${doc.title} » a été rejeté par ${by.display_name} à l'étape « ${step.name} ».`,
        `Motif : ${comment}`,
        link(doc),
      ]);
    },
  };
}

module.exports = { createNotifier };
