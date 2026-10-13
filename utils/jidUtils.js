export const S_WHATSAPP_NET = '@s.whatsapp.net';
export const OFFICIAL_BIZ_JID = '16505361212@c.us';
export const SERVER_JID = 'server@c.us';
export const PSA_WID = '0@c.us';
export const STORIES_JID = 'status@broadcast';
export const META_AI_JID = '13135550002@c.us';

export const WAJIDDomains = {
  WHATSAPP: 0,
  LID: 1,
  HOSTED: 128,
  HOSTED_LID: 129,
};

export const getServerFromDomainType = (initialServer, domainType) => {
  switch (domainType) {
    case WAJIDDomains.LID:
      return 'lid';
    case WAJIDDomains.HOSTED:
      return 'hosted';
    case WAJIDDomains.HOSTED_LID:
      return 'hosted.lid';
    case WAJIDDomains.WHATSAPP:
    default:
      return initialServer;
  }
};

export const jidEncode = (user, server, device, agent) => {
  return `${user || ''}${agent ? `_${agent}` : ''}${device ? `:${device}` : ''}@${server}`;
};

export const jidDecode = (jid) => {
  if (typeof jid !== 'string') {
    return undefined;
  }

  const sepIdx = jid.indexOf('@');
  if (sepIdx < 0) {
    return undefined;
  }

  const server = jid.slice(sepIdx + 1);
  const userCombined = jid.slice(0, sepIdx);

  const [userAgent, device] = userCombined.split(':');
  const [user, agent] = (userAgent || '').split('_');

  let domainType = WAJIDDomains.WHATSAPP;
  if (server === 'lid') {
    domainType = WAJIDDomains.LID;
  } else if (server === 'hosted') {
    domainType = WAJIDDomains.HOSTED;
  } else if (server === 'hosted.lid') {
    domainType = WAJIDDomains.HOSTED_LID;
  } else if (agent) {
    domainType = parseInt(agent, 10);
  }

  return {
    server,
    user: user || '',
    domainType,
    device: device ? +device : undefined,
  };
};

/** is the jid a user */
export const areJidsSameUser = (jid1, jid2) =>
  jidDecode(jid1)?.user === jidDecode(jid2)?.user;

/** Regex pattern identifying WhatsApp bots including Meta AI */
export const botRegexp = /^1313555\d{4}$|^131655500\d{2}$/;

/** is the jid Meta AI */
export const isJidMetaAI = (jid) => {
  if (!jid) return false;
  const s = String(jid).trim().toLowerCase();
  return (
    s.endsWith('@bot') ||
    s === META_AI_JID.toLowerCase() ||
    s === '13135550002@s.whatsapp.net' ||
    s === '13135550002' ||
    (s.endsWith('@c.us') && botRegexp.test(s.split('@')[0])) ||
    (s.endsWith('@s.whatsapp.net') && botRegexp.test(s.split('@')[0]))
  );
};

/** is the jid a bot */
export const isJidBot = (jid) => {
  if (!jid) return false;
  const s = String(jid).trim();
  const user = s.split('@')[0] || '';
  return (botRegexp.test(user) && (s.endsWith('@c.us') || s.endsWith('@s.whatsapp.net'))) || s.endsWith('@bot');
};

/** is the jid a PN user */
export const isPnUser = (jid) => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');

/** is the jid a LID */
export const isLidUser = (jid) => typeof jid === 'string' && jid.endsWith('@lid');

/** is the jid a broadcast */
export const isJidBroadcast = (jid) => typeof jid === 'string' && jid.endsWith('@broadcast');

/** is the jid a group */
export const isJidGroup = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');

/** is the jid the status broadcast */
export const isJidStatusBroadcast = (jid) => jid === 'status@broadcast';

/** is the jid a newsletter */
export const isJidNewsletter = (jid) => typeof jid === 'string' && jid.endsWith('@newsletter');

/** is the jid a hosted PN */
export const isHostedPnUser = (jid) => typeof jid === 'string' && jid.endsWith('@hosted');

/** is the jid a hosted LID */
export const isHostedLidUser = (jid) => typeof jid === 'string' && jid.endsWith('@hosted.lid');

export const jidNormalizedUser = (jid) => {
  const result = jidDecode(jid);
  if (!result) {
    return '';
  }

  const { user, server } = result;
  return jidEncode(user, server === 'c.us' ? 's.whatsapp.net' : server);
};

export const transferDevice = (fromJid, toJid) => {
  const fromDecoded = jidDecode(fromJid);
  const deviceId = fromDecoded?.device || 0;
  const decodedTo = jidDecode(toJid);
  if (!decodedTo) return toJid;
  const { server, user } = decodedTo;
  return jidEncode(user, server, deviceId);
};
