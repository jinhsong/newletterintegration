import { createHash } from 'node:crypto';
import {
  buildNewsletterSubject,
  newsletterTextFallback,
  renderNewsletterHtml,
} from './email-renderer.mjs';
import {
  loadDeliveryState,
  saveDeliveryState,
} from './local-store.mjs';
import { sendSmtpMail } from './smtp-client.mjs';

function batchSize(value) {
  const parsed = Number.parseInt(value || '40', 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('MAIL_BATCH_SIZE는 1~100 사이 정수여야 합니다.');
  }
  return parsed;
}

function groupRecipients(recipients) {
  const groups = new Map();
  for (const recipient of recipients) {
    const focus = recipient.focus || '';
    if (!groups.has(focus)) groups.set(focus, []);
    groups.get(focus).push(recipient);
  }
  return groups;
}

function makeBatchId(focus, recipients) {
  return createHash('sha256')
    .update(`${focus}\n${recipients.map((item) => item.email.toLowerCase()).join('\n')}`)
    .digest('hex')
    .slice(0, 20);
}

function chunks(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

export async function sendTestNewsletter(payload, recipient, smtpConfig) {
  const subject = `[시험] ${buildNewsletterSubject(payload)}`;
  await sendSmtpMail(smtpConfig, {
    bcc: [recipient.email],
    subject,
    text: newsletterTextFallback(payload),
    html: renderNewsletterHtml(payload, recipient.focus || ''),
  });
  return { recipients: 1, messages: 1, test: true };
}

export async function deliverNewsletter(payload, recipients, options) {
  const state = await loadDeliveryState(options.dataDir, payload.deliveryKey);
  if (state.status === 'completed') {
    throw new Error(`이미 발송 완료된 deliveryKey입니다: ${payload.deliveryKey}`);
  }
  state.status = 'sending';
  state.totalRecipients = recipients.length;
  state.sentRecipients = state.sentRecipients || {};
  state.batches = state.batches || {};
  await saveDeliveryState(options.dataDir, state);

  const size = batchSize(options.batchSize);
  const subject = buildNewsletterSubject(payload);
  const text = newsletterTextFallback(payload);
  let sentThisRun = 0;
  let messagesThisRun = 0;

  try {
    for (const [focus, group] of groupRecipients(recipients)) {
      const remaining = group.filter((recipient) => !state.sentRecipients[recipient.email.toLowerCase()]);
      if (remaining.length === 0) continue;
      const html = renderNewsletterHtml(payload, focus);
      for (const batch of chunks(remaining, size)) {
        const id = makeBatchId(focus, batch);
        state.batches[id] = {
          status: 'sending',
          focus,
          recipients: batch.map((recipient) => recipient.email),
          startedAt: new Date().toISOString(),
        };
        await saveDeliveryState(options.dataDir, state);

        await sendSmtpMail(options.smtpConfig, {
          bcc: batch.map((recipient) => recipient.email),
          subject,
          text,
          html,
        });

        const sentAt = new Date().toISOString();
        for (const recipient of batch) {
          state.sentRecipients[recipient.email.toLowerCase()] = {
            sentAt,
            focus,
          };
        }
        state.batches[id].status = 'sent';
        state.batches[id].sentAt = sentAt;
        sentThisRun += batch.length;
        messagesThisRun += 1;
        await saveDeliveryState(options.dataDir, state);
      }
    }

    state.status = 'completed';
    state.completedAt = new Date().toISOString();
    state.sentCount = Object.keys(state.sentRecipients).length;
    delete state.lastError;
    await saveDeliveryState(options.dataDir, state);
    return {
      recipients: state.sentCount,
      sentThisRun,
      messagesThisRun,
      resumed: state.sentCount > sentThisRun,
    };
  } catch (error) {
    state.status = 'partial';
    state.lastError = String(error.message || error).slice(0, 2000);
    await saveDeliveryState(options.dataDir, state);
    throw error;
  }
}
