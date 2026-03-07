const AUTO_CALLBACK_CHANNELS = new Set(["whatsapp", "telegram", "slack"]);
const GENERIC_MESSAGE_CHANNELS = new Set(["webchat", "internal", "cli"]);
const ROOM_CHANNELS = new Set(["slack", "discord", "mattermost", "googlechat", "msteams"]);
const SESSION_PEER_KINDS = new Set(["direct", "group", "channel", "room"]);

function normalizeString(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeChannelId(value) {
  return normalizeString(value)?.toLowerCase();
}

function resolveReplyMode(channelId, hasTarget) {
  if (!channelId || !hasTarget) {
    return "manual_status";
  }
  return AUTO_CALLBACK_CHANNELS.has(channelId) ? "auto_callback" : "manual_status";
}

function inferConversationIdFromSessionKey(sessionKey) {
  return parseSessionKeyMetadata(sessionKey).conversationId;
}

function parseSessionKeyMetadata(sessionKey) {
  const normalized = normalizeString(sessionKey);
  if (!normalized) {
    return {};
  }

  const parts = normalized.split(":");
  const metadata = {};

  if (parts[0] === "agent") {
    if (parts.length >= 6 && SESSION_PEER_KINDS.has(parts[4])) {
      metadata.channelId = normalizeChannelId(parts[2]);
      metadata.accountId = normalizeString(parts[3]);
      metadata.conversationId = normalizeString(parts.slice(5).join(":"));
      return metadata;
    }

    if (parts.length >= 5 && SESSION_PEER_KINDS.has(parts[3])) {
      metadata.channelId = normalizeChannelId(parts[2]);
      metadata.conversationId = normalizeString(parts.slice(4).join(":"));
      return metadata;
    }

    if (parts.length >= 4 && SESSION_PEER_KINDS.has(parts[2])) {
      metadata.conversationId = normalizeString(parts.slice(3).join(":"));
      return metadata;
    }
  }

  for (let index = 0; index < parts.length; index += 1) {
    if (!SESSION_PEER_KINDS.has(parts[index])) {
      continue;
    }

    const peerId = parts.slice(index + 1).join(":").trim();
    if (peerId.length > 0) {
      metadata.conversationId = peerId;
      return metadata;
    }
  }

  return metadata;
}

export function buildOriginFromCommandContext(ctx) {
  const channelId = normalizeChannelId(ctx.channelId ?? ctx.channel);
  const senderId = normalizeString(ctx.senderId ?? ctx.from);
  const conversationId = ROOM_CHANNELS.has(channelId)
    ? normalizeString(ctx.to ?? ctx.from ?? ctx.senderId)
    : normalizeString(ctx.from ?? ctx.senderId ?? ctx.to);
  const replyMode = resolveReplyMode(channelId, Boolean(conversationId ?? senderId));

  return {
    channelId,
    replyMode,
    ...(normalizeString(ctx.accountId) ? { accountId: ctx.accountId.trim() } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(senderId ? { senderId } : {}),
    ...(typeof ctx.messageThreadId === "number" ? { threadId: ctx.messageThreadId } : {})
  };
}

export function buildOriginFromToolContext(ctx) {
  const sessionKey = normalizeString(ctx.sessionKey);
  const sourceChannelId = normalizeChannelId(ctx.messageChannel);
  const sessionMetadata = parseSessionKeyMetadata(sessionKey);
  const channelId =
    sourceChannelId && !GENERIC_MESSAGE_CHANNELS.has(sourceChannelId)
      ? sourceChannelId
      : sessionMetadata.channelId ?? sourceChannelId;
  const senderId = normalizeString(ctx.requesterSenderId);
  const conversationId = sessionMetadata.conversationId ?? inferConversationIdFromSessionKey(sessionKey) ?? senderId;
  const hasTarget = Boolean(conversationId ?? senderId);
  const shouldAutoReply =
    Boolean(channelId) &&
    hasTarget &&
    AUTO_CALLBACK_CHANNELS.has(channelId) &&
    sourceChannelId === channelId;

  return {
    channelId,
    replyMode: shouldAutoReply ? "auto_callback" : "manual_status",
    ...(normalizeString(ctx.agentAccountId ?? sessionMetadata.accountId)
      ? { accountId: (ctx.agentAccountId ?? sessionMetadata.accountId).trim() }
      : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(senderId ? { senderId } : {}),
    ...(sessionKey ? { sessionKey } : {})
  };
}
