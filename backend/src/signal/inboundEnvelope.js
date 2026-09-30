/**
 * Flattens a signal-cli-rest-api receive envelope into the shape the rest of
 * the inbound pipeline works with. Pure -- see test/inboundEnvelope.test.js.
 */
export function normalizeEnvelope(envelope) {
  // `syncMessage.sentMessage` is a message *this account* sent from another
  // linked device, echoed back to us. Treating those as inbound makes the bot
  // answer its own confirmations, so they are flagged and dropped rather than
  // parsed. (The old code read them as ordinary inbound messages.)
  const sync = envelope?.syncMessage?.sentMessage;
  const dataMessage = envelope?.dataMessage ?? sync ?? null;

  const messageText = (dataMessage?.message ?? '').trim();

  const senderNumber = envelope?.sourceNumber ?? envelope?.source ?? null;
  const senderUuid = envelope?.sourceUuid ?? null;
  const senderName = envelope?.sourceName ?? null;

  // Group id lives in different places across signal-cli-rest-api versions.
  const groupId =
    dataMessage?.groupInfo?.groupId ??
    dataMessage?.groupContext?.groupId ??
    dataMessage?.groupContext?.id ??
    null;

  return {
    isSync: Boolean(sync && !envelope?.dataMessage),
    isReaction: Boolean(dataMessage?.reaction),
    reaction: normalizeReaction(dataMessage?.reaction),
    senderNumber,
    senderUuid,
    senderName,
    // Signal identifies a message by (author, sent timestamp) -- there is no
    // message id -- and that pair is what a reaction has to target, so the
    // dataMessage timestamp is preferred over the envelope's.
    timestamp: dataMessage?.timestamp ?? envelope?.timestamp ?? Date.now(),
    groupId,
    groupName: '',
    messageText,
    rawEnvelope: envelope,
  };
}

/**
 * A reaction names the message it is about the only way Signal can: its
 * author and the timestamp that message was sent with. That pair is how an
 * approval reaction is matched back to the review request the bot sent.
 */
function normalizeReaction(reaction) {
  if (!reaction) return null;
  const target = reaction.targetSentTimestamp ?? reaction.targetTimestamp ?? null;
  return {
    emoji: reaction.emoji ?? '',
    targetAuthor: reaction.targetAuthorNumber ?? reaction.targetAuthor ?? null,
    targetTimestamp: target === null ? null : Number(target),
    isRemove: Boolean(reaction.isRemove),
  };
}

/** Who a reaction to this message must name as its target author. */
export function targetAuthorOf(normalized) {
  return normalized.senderNumber ?? normalized.senderUuid ?? null;
}
