import * as messageLogRepo from '../messageLog/messageLog.repository.js';
import { addWorkPackageComment } from '../openproject/openprojectClient.js';

/**
 * Posts an already-rendered rule comment to a work package's activity and
 * logs the outcome as its own message_log row (recipient `OpenProject #id`).
 *
 * Called only once the Signal message it describes has really been sent --
 * straight after an immediate send in ruleProcessor, or by the outbound
 * dispatcher after a batch goes out. A failure here is logged and swallowed:
 * the notification already went, and must not be reported as failed because
 * OpenProject refused a note.
 */
export async function postRuleComment(db, { ruleId, workPackageId, comment }) {
  if (!comment || !String(comment).trim() || !workPackageId) return;
  const entry = {
    direction: 'outbound',
    ruleId,
    workPackageId,
    recipient: `OpenProject #${workPackageId}`,
    content: `Comment on work package #${workPackageId}: ${comment}`,
  };
  try {
    const op = db.prepare('SELECT base_url, api_key FROM openproject_settings WHERE id = 1').get();
    if (!op?.base_url || !op?.api_key) {
      throw new Error('OpenProject base URL / API key are not configured');
    }
    await addWorkPackageComment(op.base_url, op.api_key, workPackageId, comment);
    messageLogRepo.insert(db, { ...entry, status: 'sent' });
  } catch (err) {
    messageLogRepo.insert(db, { ...entry, status: 'failed', errorMessage: err.message });
  }
}
