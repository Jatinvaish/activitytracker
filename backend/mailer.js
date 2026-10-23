const nodemailer = require('nodemailer');

function getTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function send({ to, subject, body }) {
  if (!process.env.SMTP_HOST) throw new Error('SMTP not configured');
  await getTransporter().sendMail({
    from:    process.env.SMTP_USER,
    to,
    subject,
    text:    body || '',
  });
}

module.exports = { send };
